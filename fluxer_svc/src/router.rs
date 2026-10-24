// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::config::ServiceConfig;
use crate::hash_ring::HashRing;
use crate::metrics::ServiceMetrics;
use crate::transport::{
    Transport, TransportMessage, TransportSubscriber, reply_bytes, reply_json_error,
};
use anyhow::Context;
use futures::future::{BoxFuture, FutureExt, Shared};
use futures::stream::{FuturesUnordered, StreamExt};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Semaphore, TryAcquireError};
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

pub const SHARD_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BROADCAST_CONCURRENCY: usize = 32;
pub(crate) const MAX_ROUTER_REQUEST_BYTES: usize = 2 * 1024 * 1024;
type InflightKey = (String, String);
type InflightCall<V, E> = Shared<BoxFuture<'static, Result<V, Arc<E>>>>;
pub(crate) type Inflight<V, E> = Arc<Mutex<HashMap<InflightKey, InflightCall<V, E>>>>;

pub trait RouterService: Send + Sync + 'static {
    type Request: serde::Serialize + serde::de::DeserializeOwned + Send + Sync + 'static;
    type Response: serde::Serialize + serde::de::DeserializeOwned + Clone + Send + Sync + 'static;

    const CACHES_RESPONSES: bool = true;

    fn service_name(&self) -> &str;
    fn route_key(request: &Self::Request) -> String;
    fn shard_for(&self, request: &Self::Request, ring: &HashRing) -> u32 {
        ring.owner(&Self::route_key(request))
    }
    fn coalesce_key(_request: &Self::Request) -> Option<String> {
        None
    }

    fn is_broadcast_request(_request: &Self::Request) -> bool {
        false
    }
    fn is_broadcast_acknowledgement(_response: &Self::Response) -> bool {
        false
    }

    fn l1_lookup(&self, _req: &Self::Request) -> Option<Self::Response> {
        None
    }
    fn l1_insert(&self, _req: &Self::Request, _resp: &Self::Response) {}
}

fn shard_subject<S: RouterService>(service: &S, ring: &HashRing, request: &S::Request) -> String {
    let shard_id = service.shard_for(request, ring);
    format!("svc.{}.shard.{shard_id}", service.service_name())
}

async fn forward_to_shard<S: RouterService>(
    transport: &impl Transport,
    subject: &str,
    request: &S::Request,
) -> anyhow::Result<Vec<u8>> {
    let msgpack_payload = rmp_serde::to_vec_named(request)
        .map_err(|e| anyhow::anyhow!("failed to encode request as msgpack: {e}"))?;
    transport
        .request(subject, &msgpack_payload, SHARD_REQUEST_TIMEOUT)
        .await
}

async fn forward_to_shard_verbatim(
    transport: &impl Transport,
    subject: &str,
    payload: &[u8],
) -> anyhow::Result<Vec<u8>> {
    transport
        .request(subject, payload, SHARD_REQUEST_TIMEOUT)
        .await
}

async fn dispatch_to_shard<S: RouterService>(
    transport: &impl Transport,
    service: &S,
    ring: &HashRing,
    request: &S::Request,
    payload: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let subject = shard_subject(service, ring, request);
    if S::CACHES_RESPONSES {
        forward_to_shard::<S>(transport, &subject, request).await
    } else {
        forward_to_shard_verbatim(transport, &subject, payload).await
    }
}

async fn forward_to_all_shards<S: RouterService>(
    transport: &impl Transport,
    service: &S,
    ring: &HashRing,
    request: &S::Request,
) -> anyhow::Result<Vec<u8>> {
    let payload = rmp_serde::to_vec_named(request)
        .context("failed to encode broadcast request as msgpack")?;
    let payload = payload.as_slice();
    let service_name = service.service_name();
    let deadline = tokio::time::Instant::now() + SHARD_REQUEST_TIMEOUT;
    let request_shard = |shard_id| async move {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            anyhow::bail!("broadcast deadline expired before shard {shard_id}");
        }
        let subject = format!("svc.{service_name}.shard.{shard_id}");
        let response_bytes = transport
            .request(&subject, payload, timeout)
            .await
            .with_context(|| format!("broadcast request to shard {shard_id} failed"))?;
        let response = rmp_serde::from_slice::<S::Response>(&response_bytes)
            .with_context(|| format!("invalid broadcast response from shard {shard_id}"))?;
        if !S::is_broadcast_acknowledgement(&response) {
            anyhow::bail!("unexpected broadcast acknowledgement from shard {shard_id}");
        }
        anyhow::Ok(response)
    };

    let mut shard_ids = 0..ring.shard_count();
    let mut pending = FuturesUnordered::new();
    for shard_id in shard_ids.by_ref().take(MAX_BROADCAST_CONCURRENCY) {
        pending.push(request_shard(shard_id));
    }

    let mut acknowledgement = None;
    let mut first_error = None;
    while let Some(result) = pending.next().await {
        match result {
            Ok(response) => acknowledgement = Some(response),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
        if first_error.is_none()
            && let Some(shard_id) = shard_ids.next()
        {
            pending.push(request_shard(shard_id));
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    let acknowledgement = acknowledgement.context("broadcast request has no configured shards")?;
    if S::CACHES_RESPONSES {
        rmp_serde::to_vec_named(&acknowledgement)
            .context("failed to encode broadcast acknowledgement as msgpack")
    } else {
        serde_json::to_vec(&acknowledgement)
            .context("failed to encode broadcast acknowledgement as json")
    }
}

pub(crate) async fn coalesce<V, E, F>(
    inflight: &Inflight<V, E>,
    key: InflightKey,
    call: F,
) -> Result<V, Arc<E>>
where
    V: Clone + Send + Sync + 'static,
    E: Send + Sync + 'static,
    F: Future<Output = Result<V, E>> + Send + 'static,
{
    let shared = {
        let mut calls = inflight.lock().unwrap();
        calls
            .entry(key.clone())
            .or_insert_with(|| {
                let inflight = inflight.clone();
                async move {
                    let result = call.await.map_err(Arc::new);
                    inflight.lock().unwrap().remove(&key);
                    result
                }
                .boxed()
                .shared()
            })
            .clone()
    };
    shared.await
}

async fn reply_json_response(
    message: &impl TransportMessage,
    transport: &impl Transport,
    response: &impl serde::Serialize,
    metrics: &ServiceMetrics,
) {
    if !message.has_reply() {
        return;
    }
    match serde_json::to_vec(response) {
        Ok(payload) => reply_bytes(message, transport, &payload).await,
        Err(error) => {
            warn!(error = %error, subject = message.subject(), "failed to encode router response");
            metrics.record_request_error();
            reply_json_error(message, transport, "encode_error").await;
        }
    }
}

async fn handle_router_request<S, T>(
    msg: T::Message,
    transport: T,
    service: Arc<S>,
    ring: Arc<HashRing>,
    inflight: Inflight<Vec<u8>, anyhow::Error>,
    metrics: Arc<ServiceMetrics>,
) where
    S: RouterService,
    T: Transport,
{
    let request_start = Instant::now();
    metrics.record_request();
    if msg.payload().len() > MAX_ROUTER_REQUEST_BYTES {
        warn!(
            payload_bytes = msg.payload().len(),
            max_payload_bytes = MAX_ROUTER_REQUEST_BYTES,
            "rejecting oversized router request"
        );
        metrics.record_request_error();
        reply_json_error(&msg, &transport, "request_too_large").await;
        return;
    }
    let request: S::Request = match serde_json::from_slice(msg.payload()) {
        Ok(r) => r,
        Err(err) => {
            warn!(error = %err, "failed to decode incoming request");
            metrics.record_request_error();
            reply_json_error(&msg, &transport, "decode_error").await;
            return;
        }
    };
    let request = Arc::new(request);
    let broadcast = S::is_broadcast_request(&request);

    if S::CACHES_RESPONSES
        && !broadcast
        && let Some(cached) = service.l1_lookup(&request)
    {
        metrics.record_cache_hit();
        metrics.record_request_duration(request_start.elapsed().as_millis() as u64);
        reply_json_response(&msg, &transport, &cached, &metrics).await;
        return;
    }

    let route_key = S::route_key(&request);
    metrics.record_cache_miss();
    metrics.record_shard_forward();

    let coalesce_result = if broadcast {
        forward_to_all_shards::<S>(&transport, service.as_ref(), ring.as_ref(), &request).await
    } else if let Some(coalesce_key) = S::coalesce_key(&request) {
        let forward_transport = transport.clone();
        let forward_service = service.clone();
        let forward_ring = ring.clone();
        let forward_request = request.clone();
        let forward_payload = if S::CACHES_RESPONSES {
            Vec::new()
        } else {
            msg.payload().to_vec()
        };
        let inflight_key = (route_key, coalesce_key);
        coalesce(&inflight, inflight_key, async move {
            dispatch_to_shard::<S>(
                &forward_transport,
                forward_service.as_ref(),
                forward_ring.as_ref(),
                &forward_request,
                &forward_payload,
            )
            .await
        })
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))
    } else {
        dispatch_to_shard::<S>(
            &transport,
            service.as_ref(),
            ring.as_ref(),
            &request,
            msg.payload(),
        )
        .await
    };

    metrics.record_request_duration(request_start.elapsed().as_millis() as u64);

    match coalesce_result {
        Ok(response_bytes) => {
            if !S::CACHES_RESPONSES {
                if msg.has_reply() {
                    reply_bytes(&msg, &transport, &response_bytes).await;
                }
                return;
            }
            match rmp_serde::from_slice::<S::Response>(&response_bytes) {
                Ok(response) => {
                    if !broadcast {
                        service.l1_insert(&request, &response);
                    }
                    reply_json_response(&msg, &transport, &response, &metrics).await;
                }
                Err(err) => {
                    debug!(error = %err, "failed to decode shard response");
                    if msg.has_reply() {
                        if serde_json::from_slice::<serde_json::Value>(&response_bytes).is_ok() {
                            reply_bytes(&msg, &transport, &response_bytes).await;
                            return;
                        }
                        reply_json_error(&msg, &transport, "shard_decode_error").await;
                    }
                }
            }
        }
        Err(err) => {
            debug!(error = %err, "shard request failed (coalesced)");
            metrics.record_request_error();
            reply_json_error(&msg, &transport, "shard_unavailable").await;
        }
    }
}

pub async fn run_router<S>(
    config: &ServiceConfig,
    service: S,
    transport: impl Transport,
) -> anyhow::Result<()>
where
    S: RouterService,
{
    let service = Arc::new(service);
    let ring = Arc::new(HashRing::new(config.shard_count));
    let name = service.service_name().to_owned();
    let request_subject = format!("svc.{name}");
    let queue_group = format!("{name}-router");

    let metrics = Arc::new(ServiceMetrics::default());
    metrics.init();

    let inflight = Inflight::<Vec<u8>, anyhow::Error>::default();

    let mut tasks = JoinSet::new();

    let health_addr = config.listen_addr;
    let router_serving = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let http_serving = router_serving.clone();
    let http_metrics = metrics.clone();
    let http_name = name.clone();
    tasks.spawn(async move {
        crate::server::run_http(health_addr, http_serving, http_metrics, http_name).await
    });

    let req_transport = transport.clone();
    let req_service = service.clone();
    let req_queue = queue_group.clone();
    let req_metrics = metrics.clone();
    let req_permits = Arc::new(Semaphore::new(config.max_concurrent_requests));
    tasks.spawn(async move {
        let mut requests = JoinSet::new();
        loop {
            let mut sub = req_transport
                .subscribe_queue(&request_subject, &req_queue)
                .await?;
            info!(
                subject = request_subject,
                max_concurrent_requests = req_permits.available_permits(),
                "router listening for requests"
            );

            loop {
                let msg = tokio::select! {
                    result = requests.join_next(), if !requests.is_empty() => {
                        if let Err(err) = result.expect("nonempty router request set") {
                            warn!(error = %err, "router request task failed");
                        }
                        continue;
                    }
                    msg_opt = sub.next() => {
                        let Some(msg) = msg_opt else {
                            warn!("router request subscription stream ended, will re-subscribe");
                            break;
                        };
                        msg
                    }
                };

                while let Some(result) = requests.try_join_next() {
                    if let Err(err) = result {
                        warn!(error = %err, "router request task failed");
                    }
                }
                let permit = match req_permits.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(TryAcquireError::NoPermits) => {
                        debug!("shedding router request, no permits available");
                        req_metrics.record_request();
                        req_metrics.record_request_error();
                        reply_json_error(&msg, &req_transport, "overloaded").await;
                        continue;
                    }
                    Err(TryAcquireError::Closed) => return anyhow::Ok(()),
                };
                let transport = req_transport.clone();
                let service = req_service.clone();
                let ring = ring.clone();
                let inflight = inflight.clone();
                let metrics = req_metrics.clone();
                requests.spawn(async move {
                    let _permit = permit;
                    handle_router_request::<S, _>(msg, transport, service, ring, inflight, metrics)
                        .await;
                });
            }
        }
    });

    tokio::select! {
        result = tasks.join_next() => {
            match result {
                Some(Ok(Ok(()))) => Ok(()),
                Some(Ok(Err(error))) => Err(error),
                Some(Err(error)) => Err(error.into()),
                None => Ok(()),
            }
        }
        _ = crate::shutdown::wait_for_shutdown() => {
            info!("router shutting down");
            router_serving.store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }
}
