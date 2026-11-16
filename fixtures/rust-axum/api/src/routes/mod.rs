mod users;

use axum::{routing::get, Router};

pub fn app() -> Router {
    let api = Router::new().route("/users", get(users::list).post(users::create));
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/api", api)
        .nest("/v2", users::router())
}
