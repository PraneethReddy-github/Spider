use axum::{extract::State, routing::get, Router};
use domain::repo::{MemRepo, Store};
use domain::User;

use super::super::legacy;

pub async fn list(State(repo): State<MemRepo>) -> String {
    let found = repo.find(1);
    repo.count();
    legacy::log();
    format!("{}", found.is_some())
}

pub async fn create() -> String {
    let u = User::new(2);
    u.label()
}

pub fn router() -> Router {
    Router::new().route("/items/:id", get(list))
}
