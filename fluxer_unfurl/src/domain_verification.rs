// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{http_fetch, network_policy};
use fluxer_common::public_ip::is_valid_public_hostname;
use hickory_resolver::TokioResolver;
use hickory_resolver::config::{NameServerConfig, ResolveHosts, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::{RData, RecordType};
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, HeaderValue};
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use tokio::time::timeout;
use url::Url;

const WELL_KNOWN_TIMEOUT: Duration = Duration::from_millis(3000);
const WELL_KNOWN_MAX_BYTES: usize = 16 * 1024;
const WELL_KNOWN_PATH: &str = "/.well-known/fluxer-verification";
const MAX_TOKEN_BYTES: usize = 256;

pub async fn verify_domain(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
) -> anyhow::Result<bool> {
    validate_domain(domain)?;
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        anyhow::bail!("invalid verification token");
    }
    if dns_txt_matches(domain, token).await {
        return Ok(true);
    }
    match timeout(
        WELL_KNOWN_TIMEOUT,
        well_known_matches(client, domain, token),
    )
    .await
    {
        Ok(Ok(matched)) => Ok(matched),
        Ok(Err(err)) => {
            tracing::debug!(error = %err, domain, "well-known verification lookup failed");
            Ok(false)
        }
        Err(_) => {
            tracing::debug!(domain, "well-known verification lookup timed out");
            Ok(false)
        }
    }
}

async fn dns_txt_matches(domain: &str, token: &str) -> bool {
    let expected = format!("fluxer-verification={token}");
    let mut lookups = JoinSet::new();
    for server in DNS_SERVERS {
        let record_name = record_name.clone();
        lookups.spawn(async move { lookup_txt(IpAddr::V4(server), &record_name).await });
    }
    while let Some(result) = lookups.join_next().await {
        match result {
            Ok(Ok(records)) if records.iter().any(|record| record == &expected) => {
                lookups.abort_all();
                return true;
            }
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                tracing::debug!(error = %err, domain, "DNS TXT verification lookup failed");
            }
            Err(err) => {
                tracing::debug!(error = %err, domain, "DNS TXT verification task failed");
            }
        }
    }
    false
}

async fn well_known_matches(
    client: &reqwest::Client,
    domain: &str,
    token: &str,
) -> anyhow::Result<bool> {
    let url = Url::parse(&format!("https://{domain}{WELL_KNOWN_PATH}"))?;
    if url.host_str() != Some(domain) || url.port().is_some() || url.path() != WELL_KNOWN_PATH {
        anyhow::bail!("verification URL does not match the domain");
    }
    network_policy::validate_url(&url).await?;
    let response = client
        .get(url)
        .header(ACCEPT_ENCODING, HeaderValue::from_static("identity"))
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(false);
    }
    if let Some(encoding) = response.headers().get(CONTENT_ENCODING)
        && !encoding
            .to_str()
            .is_ok_and(|value| value.trim().eq_ignore_ascii_case("identity"))
    {
        return Ok(false);
    }
    if response
        .content_length()
        .is_some_and(|len| len > WELL_KNOWN_MAX_BYTES as u64)
    {
        return Ok(false);
    }
    let body = http_fetch::read_body(response, WELL_KNOWN_MAX_BYTES).await?;
    Ok(body_matches_token(&body, token))
}

fn body_matches_token(body: &[u8], token: &str) -> bool {
    let text = String::from_utf8_lossy(body);
    text.strip_prefix('\u{feff}').unwrap_or(&text).trim() == token
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_must_equal_token_after_trimming() {
        assert!(body_matches_token(b"abc123", "abc123"));
        assert!(body_matches_token(b"  abc123\r\n", "abc123"));
        assert!(body_matches_token("\u{feff}abc123\n".as_bytes(), "abc123"));
        assert!(!body_matches_token(b"abc1234", "abc123"));
        assert!(!body_matches_token(b"fluxer-verification=abc123", "abc123"));
        assert!(!body_matches_token(b"", "abc123"));
    }

    #[test]
    fn joins_split_txt_strings() {
        let strings: Vec<Box<[u8]>> = vec![
            b"fluxer-verification=".to_vec().into_boxed_slice(),
            b"abc123".to_vec().into_boxed_slice(),
        ];
        assert_eq!(join_txt_strings(&strings), "fluxer-verification=abc123");
    }
}
