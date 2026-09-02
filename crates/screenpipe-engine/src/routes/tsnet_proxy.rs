// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Main-API facade for the local tsnet sidecar. Clients keep one authenticated
//! Screenpipe base URL; the sidecar's loopback coordinator remains an internal
//! transport and never receives the caller's credentials.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use once_cell::sync::Lazy;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tracing::warn;

use crate::server::AppState;

static TSNET_SIDECAR_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("tsnet sidecar reqwest client")
});

fn sidecar_base_url() -> String {
    std::env::var("SCREENPIPE_TSNET_SIDECAR_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3031".to_string())
        .trim_end_matches('/')
        .to_string()
}

async fn proxy(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    method: Method,
    path: &str,
    body: Option<Bytes>,
) -> Response {
    let Some(api_key) = api_key.filter(|value| !value.is_empty()) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "device_mesh_api_key_missing",
                "message": "the device mesh requires the local Screenpipe API key",
            })),
        )
            .into_response();
    };

    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut request = client
        .request(method, url)
        .bearer_auth(api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(body) = body {
        request = request.body(body);
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            warn!("tsnet sidecar proxy failed: {}", error);
            let status = if error.is_timeout() {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            return (
                status,
                Json(json!({
                    "error": if error.is_timeout() { "device_mesh_timeout" } else { "device_mesh_unavailable" },
                    "message": "the Screenpipe device mesh is not available",
                })),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    let mut headers = HeaderMap::new();
    if let Some(content_type) = upstream.headers().get(reqwest::header::CONTENT_TYPE) {
        headers.insert(axum::http::header::CONTENT_TYPE, content_type.clone());
    }
    (status, headers, Body::from_stream(upstream.bytes_stream())).into_response()
}

pub async fn devices(State(state): State<Arc<AppState>>) -> Response {
    proxy(
        &TSNET_SIDECAR_CLIENT,
        &sidecar_base_url(),
        state.api_auth_key.as_deref(),
        Method::GET,
        "/v1/devices",
        None,
    )
    .await
}

pub async fn query(State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    proxy(
        &TSNET_SIDECAR_CLIENT,
        &sidecar_base_url(),
        state.api_auth_key.as_deref(),
        Method::POST,
        "/v1/query",
        Some(body),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use http_body_util::BodyExt;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn proxy_injects_the_server_key_and_preserves_response() {
        let upstream = Router::new().route(
            "/v1/devices",
            get(|headers: HeaderMap| async move {
                assert_eq!(
                    headers.get(axum::http::header::AUTHORIZATION).unwrap(),
                    "Bearer local-key"
                );
                (
                    StatusCode::ACCEPTED,
                    Json(json!({"devices": [{"name": "screenpipe-mac"}]})),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let response = proxy(
            &reqwest::Client::new(),
            &format!("http://{}", address),
            Some("local-key"),
            Method::GET,
            "/v1/devices",
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("screenpipe-mac"));

        task.abort();
    }

    #[tokio::test]
    async fn proxy_fails_closed_without_the_server_key() {
        let response = proxy(
            &reqwest::Client::new(),
            "http://127.0.0.1:1",
            None,
            Method::GET,
            "/v1/devices",
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("device_mesh_api_key_missing"));
    }
}
