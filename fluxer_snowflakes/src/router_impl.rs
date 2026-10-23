// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::types::{SERVICE_NAME, SnowflakeRequest, SnowflakeResponse};
use fluxer_svc::hash_ring::HashRing;
use fluxer_svc::router::RouterService;
use std::sync::atomic::{AtomicU32, Ordering};

pub struct RoundRobinShardPicker {
    next: AtomicU32,
    shard_count: u32,
}

impl SnowflakesRouter {
    pub fn new(shard_count: u32) -> Self {
        Self {
            picker: SnowflakeShardPicker::new(shard_count),
        }
    }
}

impl RouterService for SnowflakesRouter {
    type Request = SnowflakeRequest;
    type Response = SnowflakeResponse;
    const CACHES_RESPONSES: bool = false;
    fn service_name(&self) -> &str {
        SERVICE_NAME
    }
    fn route_key(request: &Self::Request) -> String {
        request.routing_key().unwrap_or_default().to_owned()
    }
    fn shard_for(&self, request: &Self::Request, _ring: &HashRing) -> u32 {
        self.picker.pick_shard(request)
    }
}
