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

fn enrollment_url() -> String {
    std::env::var("SCREENPIPE_MESH_ENROLLMENT_URL")
        .unwrap_or_else(|_| "https://api.screenpipe.com/v1/mesh/enroll".to_string())
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
