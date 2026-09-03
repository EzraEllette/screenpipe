// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Private credential bridge for the bundled device mesh. The tsnet process
//! authenticates to localhost with the local API key; only this process can
//! read the Screenpipe account token used to request a one-use node key.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use once_cell::sync::Lazy;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tracing::warn;

use crate::server::AppState;

static ENROLLMENT_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("mesh enrollment reqwest client")
});

const DEFAULT_ENROLLMENT_URL: &str = "https://api.screenpipe.com/v1/mesh/enroll";

fn resolve_enrollment_url(runtime: Option<String>, baked: Option<&str>) -> String {
    runtime
        .as_deref()
        .or(baked)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ENROLLMENT_URL)
        .to_string()
}

fn enrollment_url() -> String {
    resolve_enrollment_url(
        std::env::var("SCREENPIPE_MESH_ENROLLMENT_URL").ok(),
        option_env!("SCREENPIPE_MESH_ENROLLMENT_URL"),
    )
}

pub async fn enroll(State(state): State<Arc<AppState>>, body: axum::body::Bytes) -> Response {
    let token = state.cloud_token.load();
    let Some(token) = (**token).clone().filter(|value| !value.is_empty()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "screenpipe_account_required",
                "message": "sign in to Screenpipe to connect this device",
            })),
        )
            .into_response();
    };

    let response = match ENROLLMENT_CLIENT
        .post(enrollment_url())
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            warn!("mesh enrollment upstream failed: {}", error);
            return (
                if error.is_timeout() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                },
                Json(json!({
                    "error": "mesh_enrollment_unavailable",
                    "message": "Screenpipe could not enroll this device",
                })),
            )
                .into_response();
        }
    };

    let status = response.status();
    let mut headers = HeaderMap::new();
    if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
        headers.insert(axum::http::header::CONTENT_TYPE, content_type.clone());
    }
    (status, headers, Body::from_stream(response.bytes_stream())).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_override_wins_over_baked_endpoint() {
        assert_eq!(
            resolve_enrollment_url(
                Some(" https://runtime.example/v1/mesh/enroll ".to_string()),
                Some("https://baked.example/v1/mesh/enroll"),
            ),
            "https://runtime.example/v1/mesh/enroll"
        );
    }

    #[test]
    fn baked_endpoint_wins_over_production_default() {
        assert_eq!(
            resolve_enrollment_url(None, Some("https://staging.example/v1/mesh/enroll")),
            "https://staging.example/v1/mesh/enroll"
        );
        assert_eq!(resolve_enrollment_url(None, None), DEFAULT_ENROLLMENT_URL);
    }
}
