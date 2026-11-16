use actix_web::{get, web, App, HttpResponse, Responder};

#[get("/hello/{name}")]
async fn hello(name: web::Path<String>) -> impl Responder {
    log();
    HttpResponse::Ok().body(name.into_inner())
}

async fn bye() -> impl Responder {
    HttpResponse::Ok()
}

pub fn log() {}

pub fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/bye").route(web::get().to(bye)));
}

pub fn run() {
    let _app = App::new()
        .service(web::scope("/legacy").service(hello).configure(config))
        .route("/ping", web::post().to(bye));
}
