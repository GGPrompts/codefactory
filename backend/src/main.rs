mod state;
mod terminal;
mod ws;

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
};
use tracing::{info, warn};

use serde::Serialize;

use state::AppState;

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Shared application state
    let app_state = Arc::new(AppState::default());

    // CORS layer — allow everything for local dev
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Static file serving from frontend/ directory with SPA fallback
    let frontend_dir = ServeDir::new("frontend").fallback(
        tower_http::services::ServeFile::new("frontend/index.html"),
    );

    // Build router
    let app = Router::new()
        .route("/ws/{floor_id}", get(ws::ws_handler))
        .route("/api/floors", get(get_floors))
        .route("/api/sessions", get(get_sessions))
        .fallback_service(frontend_dir)
        .layer(cors)
        .with_state(app_state.clone());

    // Determine port
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);

    let addr = format!("0.0.0.0:{port}");
    info!("CodeFactory backend starting on {addr}");

    // Bind and serve with graceful shutdown
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind to address");

    // Check for orphaned tmux sessions on startup
    let recovery_state = app_state.clone();
    tokio::spawn(async move {
        // Give the server a moment to fully start
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        match recovery_state.terminal_manager.list_orphaned_sessions() {
            Ok(orphans) if !orphans.is_empty() => {
                info!("Found {} orphaned tmux sessions available for reconnection: {:?}", orphans.len(), orphans);
            }
            Ok(_) => {
                info!("No orphaned tmux sessions found");
            }
            Err(e) => {
                warn!("Failed to check for orphaned sessions: {}", e);
            }
        }
    });

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");
}

/// Serve the floor configuration JSON file.
async fn get_floors() -> impl IntoResponse {
    match tokio::fs::read_to_string("frontend/config/floors.json").await {
        Ok(content) => (
            StatusCode::OK,
            [("content-type", "application/json")],
            content,
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("content-type", "application/json")],
            r#"{"error":"Failed to load floor config"}"#.to_string(),
        ),
    }
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<String>,
}

/// List orphaned tmux sessions available for reconnection.
async fn get_sessions(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.terminal_manager.list_orphaned_sessions() {
        Ok(sessions) => (
            StatusCode::OK,
            Json(SessionsResponse { sessions }),
        ),
        Err(_) => (
            StatusCode::OK,
            Json(SessionsResponse { sessions: Vec::new() }),
        ),
    }
}

/// Wait for Ctrl+C to trigger graceful shutdown.
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C handler");
    info!("Shutdown signal received, stopping server...");
}
