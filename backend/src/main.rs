mod config;
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

use config::ProfileConfig;
use state::AppState;

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Load profile config (creates defaults if missing)
    let profile_config = config::load_config().unwrap_or_else(|e| {
        warn!("Failed to load profile config: {e}, using defaults");
        ProfileConfig::default()
    });

    info!(
        profiles = profile_config.profiles.len(),
        "Profile config loaded"
    );

    // Shared application state
    let app_state = Arc::new(AppState::new(profile_config));

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
        .route("/api/profiles", get(get_profiles).put(put_profiles))
        // Keep /api/floors as an alias during migration
        .route("/api/floors", get(get_profiles))
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

/// Return the current profile config as JSON.
///
/// The response wraps profiles in a `profiles` array alongside `default_cwd`,
/// and adds a synthetic `id` (1-based index) to each entry so the frontend
/// can keep using numeric floor IDs.
async fn get_profiles(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let config = state.profile_config.read().unwrap();

    // Build a response that includes an `id` field for frontend compatibility.
    let profiles_with_id: Vec<serde_json::Value> = config
        .profiles
        .iter()
        .enumerate()
        .map(|(i, p)| {
            serde_json::json!({
                "id": (i + 1).to_string(),
                "name": p.name,
                "command": p.command,
                "cwd": p.cwd.as_deref().unwrap_or(&config.default_cwd),
                "icon": p.icon,
            })
        })
        .collect();

    let body = serde_json::json!({
        "default_cwd": config.default_cwd,
        "profiles": profiles_with_id,
        // Keep "floors" alias so the existing frontend works during migration
        "floors": profiles_with_id,
    });

    (
        StatusCode::OK,
        [("content-type", "application/json")],
        body.to_string(),
    )
}

/// Replace the entire profile config.
async fn put_profiles(
    State(state): State<Arc<AppState>>,
    Json(new_config): Json<ProfileConfig>,
) -> impl IntoResponse {
    // Save to disk
    if let Err(e) = config::save_config(&new_config) {
        warn!("Failed to save profile config: {e}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Failed to save config: {e}") })),
        );
    }

    // Update in-memory state
    {
        let mut config = state.profile_config.write().unwrap();
        *config = new_config;
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "ok" })),
    )
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
