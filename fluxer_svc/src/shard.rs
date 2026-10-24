// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::config::ServiceConfig;
use crate::metrics::ServiceMetrics;
use crate::transport::{
    Transport, TransportMessage, TransportSubscriber, reply_bytes, reply_json_error,
};
use anyhow::Context;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tokio::sync::{Semaphore, TryAcquireError, oneshot};
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

const MAX_SHARD_REQUEST_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WireEncoding {
    Json,
    MessagePack,
}

impl WireEncoding {
    fn detect(payload: &[u8]) -> Self {
        match payload.iter().find(|byte| !byte.is_ascii_whitespace()) {
            Some(b'{') => Self::Json,
            _ => Self::MessagePack,
        }
    }

    fn decode<T: serde::de::DeserializeOwned>(self, payload: &[u8]) -> anyhow::Result<T> {
        match self {
            Self::Json => Ok(serde_json::from_slice(payload)?),
            Self::MessagePack => Ok(rmp_serde::from_slice(payload)?),
        }
    }

    fn encode<T: serde::Serialize>(self, value: &T) -> anyhow::Result<Vec<u8>> {
        match self {
            Self::Json => Ok(serde_json::to_vec(value)?),
            Self::MessagePack => Ok(rmp_serde::to_vec_named(value)?),
        }
    }
}

pub trait ShardService: Send + Sync + 'static {
    type Request: serde::Serialize + serde::de::DeserializeOwned + Send + 'static;
    type Response: serde::Serialize + serde::de::DeserializeOwned + Send + 'static;

    fn service_name(&self) -> &str;
    fn render_prometheus_metrics(&self, _output: &mut String) {}
    fn handle(
        &self,
        request: Self::Request,
    ) -> impl std::future::Future<Output = anyhow::Result<Self::Response>> + Send;
}

pub async fn run_shard<S>(
    config: &ServiceConfig,
    service: S,
    transport: impl Transport,
) -> anyhow::Result<()>
where
    S: ShardService,
{
    let service = Arc::new(service);
    let name = service.service_name().to_owned();
    let subject = format!("svc.{name}.shard.{}", config.shard_id);
    let metrics = shard_metrics(&service);
    let handler_transport = transport.clone();
    let handler_metrics = metrics.clone();
    serve(
        config,
        Endpoint {
            name,
            subject,
            queue_group: None,
        },
        metrics,
        transport,
        move |msg| {
            handle_shard_request(
                msg,
                handler_transport.clone(),
                service.clone(),
                handler_metrics.clone(),
            )
        },
    )
    .await
}

pub(crate) fn shard_metrics<S: ShardService>(service: &Arc<S>) -> Arc<ServiceMetrics> {
    let metrics_service = service.clone();
    let additional_renderer: Arc<dyn Fn(&mut String) + Send + Sync> =
        Arc::new(move |output| metrics_service.render_prometheus_metrics(output));
    let metrics = Arc::new(ServiceMetrics::with_additional_renderer(
        additional_renderer,
    ));
    metrics.init();
    metrics
}

async fn handle_shard_request<S, T>(
    msg: T::Message,
    transport: T,
    service: Arc<S>,
    metrics: Arc<ServiceMetrics>,
) where
    S: ShardService,
    T: Transport,
{
    if msg.payload().len() > MAX_SHARD_REQUEST_BYTES {
        warn!(
            payload_bytes = msg.payload().len(),
            max_payload_bytes = MAX_SHARD_REQUEST_BYTES,
            "dropping oversized shard request"
        );
        return;
    }
    let request_start = Instant::now();
    metrics.record_request();
    let encoding = WireEncoding::detect(msg.payload());
    let request: S::Request = match encoding.decode(msg.payload()) {
        Ok(r) => r,
        Err(err) => {
            warn!(error = %err, ?encoding, "failed to decode shard request");
            metrics.record_request_error();
            reply_json_error(&msg, &transport, "shard_request_decode_error").await;
            return;
        }
    };

    match service.handle(request).await {
        Ok(response) => {
            metrics.record_request_duration(request_start.elapsed().as_millis() as u64);
            if msg.has_reply() {
                match encoding.encode(&response) {
                    Ok(response_bytes) => {
                        reply_bytes(&msg, &transport, &response_bytes).await;
                    }
                    Err(err) => {
                        warn!(error = %err, ?encoding, "failed to encode shard response");
                        metrics.record_request_error();
                        reply_json_error(&msg, &transport, "encode_error").await;
                    }
                }
            }
        }
        Err(err) => {
            warn!(error = %err, "shard handler returned error");
            metrics.record_request_error();
            metrics.record_request_duration(request_start.elapsed().as_millis() as u64);
            reply_json_error(&msg, &transport, "shard_handler_error").await;
        }
    }
}

pub(crate) struct Endpoint {
    pub(crate) name: String,
    pub(crate) subject: String,
    pub(crate) queue_group: Option<String>,
}

pub(crate) async fn serve<T, H, F>(
    config: &ServiceConfig,
    endpoint: Endpoint,
    metrics: Arc<ServiceMetrics>,
    transport: T,
    handle: H,
) -> anyhow::Result<()>
where
    T: Transport,
    H: Fn(T::Message) -> F + Send + Sync + 'static,
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let Endpoint {
        name,
        subject,
        queue_group,
    } = endpoint;
    let health_addr = config.listen_addr;
    let is_serving = Arc::new(AtomicBool::new(true));
    let request_permits = Arc::new(Semaphore::new(config.max_concurrent_requests));

    let mut tasks = JoinSet::new();

    let http_is_serving = is_serving.clone();
    let http_metrics = metrics.clone();
    tasks.spawn(async move {
        crate::server::run_http(health_addr, http_is_serving, http_metrics, name).await
    });

    let listen_is_serving = is_serving.clone();
    let (stop_requests, mut stop_requests_rx) = oneshot::channel();
    let request_task = tasks.spawn(async move {
        let mut requests = JoinSet::new();
        'listening: loop {
            let subscribe = async {
                match queue_group.as_deref() {
                    Some(queue_group) => transport.subscribe_queue(&subject, queue_group).await,
                    None => transport.subscribe(&subject).await,
                }
            };
            let mut sub = tokio::select! {
                _ = &mut stop_requests_rx => break 'listening,
                result = subscribe => result?,
            };
            info!(
                subject,
                max_concurrent_requests = request_permits.available_permits(),
                "listening for requests"
            );

            loop {
                tokio::select! {
                    _ = &mut stop_requests_rx => break 'listening,
                    result = requests.join_next(), if !requests.is_empty() => {
                        if let Err(err) = result.expect("nonempty request set") {
                            warn!(error = %err, "request task failed");
                        }
                    }
                    msg_opt = sub.next() => {
                        let Some(msg) = msg_opt else {
                            warn!("subscription stream ended, will re-subscribe");
                            break;
                        };

                        while let Some(result) = requests.try_join_next() {
                            if let Err(err) = result {
                                warn!(error = %err, "request task failed");
                            }
                        }
                        if !listen_is_serving.load(Ordering::SeqCst) {
                            continue;
                        }

                        let permit = match request_permits.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(TryAcquireError::NoPermits) => {
                                debug!("shedding request, no permits available");
                                metrics.record_request();
                                metrics.record_request_error();
                                reply_json_error(&msg, &transport, "overloaded").await;
                                continue;
                            }
                            Err(TryAcquireError::Closed) => return anyhow::Ok(()),
                        };
                        let is_serving = listen_is_serving.clone();
                        let request = handle(msg);
                        requests.spawn(async move {
                            let _permit = permit;
                            if !is_serving.load(Ordering::SeqCst) {
                                return;
                            }
                            request.await;
                        });
                    }
                }
            }
        }
        while let Some(result) = requests.join_next().await {
            result.context("request task failed while draining")?;
        }
        anyhow::Ok(())
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
            info!("shutting down, beginning graceful drain");

            is_serving.store(false, Ordering::SeqCst);

            let _ = stop_requests.send(());
            let drain = async {
                loop {
                    let (task_id, result) = tasks.join_next_with_id().await
                        .expect("running listener while draining")
                        .context("service task failed while draining")?;
                    result?;
                    if task_id == request_task.id() {
                        return anyhow::Ok(());
                    }
                }
            };
            match tokio::time::timeout(crate::shutdown::DEFAULT_DRAIN_TIMEOUT, drain).await {
                Ok(result) => {
                    result?;
                    info!(
                        max_concurrent_requests = config.max_concurrent_requests,
                        "all in-flight requests drained"
                    );
                    info!("graceful drain completed");
                }
                Err(_) => {
                    warn!(
                        timeout_secs = crate::shutdown::DEFAULT_DRAIN_TIMEOUT.as_secs(),
                        "drain timeout exceeded, proceeding with shutdown"
                    );
                }
            }

            info!("shutdown complete");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DatabaseBackend, Mode, ServiceConfig};
    use crate::transport::InMemoryTransport;
    use serde::{Deserialize, Serialize};
    use std::time::Duration;

    #[derive(Serialize, Deserialize)]
    struct MockRequest {
        key: String,
    }

    #[derive(Serialize, Deserialize)]
    struct MockResponse {
        key: String,
    }

    struct EchoShard;

    impl ShardService for EchoShard {
        type Request = MockRequest;
        type Response = MockResponse;

        fn service_name(&self) -> &str {
            "mock"
        }

        async fn handle(&self, request: MockRequest) -> anyhow::Result<MockResponse> {
            Ok(MockResponse { key: request.key })
        }
    }

    #[test]
    fn wire_encoding_detects_json_and_msgpack_payloads() {
        let json = serde_json::to_vec(&MockRequest {
            key: "a".to_owned(),
        })
        .unwrap();
        let msgpack = rmp_serde::to_vec_named(&MockRequest {
            key: "a".to_owned(),
        })
        .unwrap();

        assert_eq!(WireEncoding::detect(&json), WireEncoding::Json);
        assert_eq!(
            WireEncoding::detect(b"  \n{\"key\":\"a\"}"),
            WireEncoding::Json
        );
        assert_eq!(WireEncoding::detect(&msgpack), WireEncoding::MessagePack);
        assert_eq!(WireEncoding::detect(b""), WireEncoding::MessagePack);
    }

    #[tokio::test]
    async fn shard_replies_in_the_request_encoding() {
        let transport = InMemoryTransport::new();
        let config = test_config(4);
        let shard_transport = transport.clone();
        let shard_task =
            tokio::spawn(async move { run_shard(&config, EchoShard, shard_transport).await });

        tokio::time::sleep(Duration::from_millis(25)).await;

        let msgpack_request = rmp_serde::to_vec_named(&MockRequest {
            key: "a".to_owned(),
        })
        .unwrap();
        let msgpack_response = transport
            .request("svc.mock.shard.0", &msgpack_request, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            rmp_serde::from_slice::<MockResponse>(&msgpack_response)
                .unwrap()
                .key,
            "a"
        );

        let json_request = serde_json::to_vec(&MockRequest {
            key: "b".to_owned(),
        })
        .unwrap();
        let json_response = transport
            .request("svc.mock.shard.0", &json_request, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(json_response, br#"{"key":"b"}"#);

        shard_task.abort();
    }

    fn test_config(max_concurrent_requests: usize) -> ServiceConfig {
        ServiceConfig {
            service_name: "mock".to_owned(),
            mode: Mode::Shard,
            database_backend: DatabaseBackend::Postgres,
            shard_id: 0,
            shard_count: 1,
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            nats_url: "memory".to_owned(),
            nats_auth_token: None,
            cache_max_entries: 100,
            cache_ttl: Duration::from_secs(30),
            max_concurrent_requests,
            scylla_hosts: Vec::new(),
            scylla_keyspace: "fluxer".to_owned(),
            scylla_username: None,
            scylla_password: None,
            postgres_url: None,
            postgres_host: "127.0.0.1".to_owned(),
            postgres_port: 5432,
            postgres_database: "fluxer".to_owned(),
            postgres_username: "fluxer".to_owned(),
            postgres_password: Some("fluxer".to_owned()),
            postgres_ssl: false,
            postgres_ssl_ca: None,
            postgres_max_connections: 1,
            postgres_kv_table: "fluxer_kv".to_owned(),
            postgres_prepared_statements: true,
        }
    }
}
