mod config;
mod state;
mod terminal;
mod ws;

use std::sync::Arc;

use axum::{
    extract::{Path, State},
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

use serde::{Deserialize, Serialize};

use config::ProfileConfig;
use state::AppState;
use ws::ServerMessage;

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
        .route("/api/session-status", get(get_session_status))
        .route("/api/panels/{*name}", get(get_panel))
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

    // Session status poller: reads Claude state files and broadcasts changes
    let poller_state = app_state.clone();
    tokio::spawn(async move {
        session_status_poller(poller_state).await;
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
    // Re-read from disk so external edits (e.g. codefactory-tui) are picked up
    if let Ok(fresh) = config::load_config() {
        let mut config = state.profile_config.write().unwrap();
        *config = fresh;
    }
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
                "cwd": p.cwd,
                "icon": p.icon,
                "panel": p.panel,
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

/// Return current Claude session status for all floors (polled from state files).
async fn get_session_status(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let claude_floors = claude_floor_ids(&state);
    let state_dir = std::path::Path::new("/tmp/claude-code-state");
    let mut statuses = Vec::new();

    for floor_id in &claude_floors {
        let file_path = state_dir.join(format!("{}.json", floor_id));
        if let Ok(content) = std::fs::read_to_string(&file_path) {
            if let Ok(sf) = serde_json::from_str::<ClaudeStateFile>(&content) {
                statuses.push(serde_json::json!({
                    "floorId": floor_id,
                    "status": sf.status,
                    "currentTool": sf.current_tool.unwrap_or_default(),
                    "subagentCount": sf.subagent_count.unwrap_or(0),
                }));
            }
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "statuses": statuses,
            "claudeFloors": claude_floors,
        })),
    )
}

/// Serve a raw markdown file.
/// If the name contains `/` or starts with `~`, treat it as an absolute path
/// (with tilde expansion). Otherwise look it up in `~/.config/codefactory/panels/`.
async fn get_panel(Path(name): Path<String>) -> impl IntoResponse {
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "text/plain")],
            "Invalid panel name".to_string(),
        );
    }

    let file_path = if name.starts_with('~') || name.starts_with('/') {
        // Absolute path — expand tilde and use directly
        std::path::PathBuf::from(config::expand_tilde(&name))
    } else {
        // Bare filename — look up in panels directory, sanitize against traversal
        let sanitized = name
            .replace('/', "")
            .replace('\\', "")
            .replace("..", "");
        let panels_dir = config::expand_tilde("~/.config/codefactory/panels");
        std::path::PathBuf::from(&panels_dir).join(&sanitized)
    };

    // Must be a regular file (not a directory, device, etc.)
    match tokio::fs::metadata(&file_path).await {
        Ok(meta) if meta.is_file() => {}
        _ => {
            return (
                StatusCode::NOT_FOUND,
                [("content-type", "text/plain")],
                format!("Panel '{}' not found", name),
            );
        }
    }

    match tokio::fs::read_to_string(&file_path).await {
        Ok(content) => (
            StatusCode::OK,
            [("content-type", "text/markdown; charset=utf-8")],
            content,
        ),
        Err(_) => (
            StatusCode::NOT_FOUND,
            [("content-type", "text/plain")],
            format!("Panel '{}' not found", name),
        ),
    }
}

// ── Session Status Poller ──────────────────────────────────────────────────

/// State file format written by TabzChrome's state-tracker.sh hook
/// (~/projects/TabzChrome/hooks/scripts/state-tracker.sh).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ClaudeStateFile {
    session_id: String,
    status: String,
    current_tool: Option<String>,
    subagent_count: Option<u32>,
    last_updated: Option<String>,
}

/// Determine which floor IDs have Claude-type profiles (command contains "claude").
fn claude_floor_ids(state: &AppState) -> Vec<String> {
    let config = state.profile_config.read().unwrap();
    config
        .profiles
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            p.command
                .as_deref()
                .map(|c| c.to_lowercase().contains("claude"))
                .unwrap_or(false)
        })
        .map(|(i, _)| {
            // Floor IDs are 1-indexed strings, matching what get_profiles returns
            (i + 1).to_string()
        })
        .collect()
}

/// Background task that polls /tmp/claude-code-state/*.json every 2 seconds
/// and broadcasts SessionStatus messages when state changes.
async fn session_status_poller(state: Arc<AppState>) {
    use std::collections::HashMap;
    use std::path::Path;

    let state_dir = Path::new("/tmp/claude-code-state");
    let mut last_states: HashMap<String, String> = HashMap::new();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        // Only poll for floors that have Claude-type profiles
        let claude_floors = claude_floor_ids(&state);
        if claude_floors.is_empty() {
            continue;
        }

        if !state_dir.exists() {
            continue;
        }

        for floor_id in &claude_floors {
            let file_path = state_dir.join(format!("{}.json", floor_id));
            if !file_path.exists() {
                // If we had a previous state and the file disappeared, broadcast idle
                if last_states.remove(floor_id).is_some() {
                    let _ = state.status_tx.send(ServerMessage::SessionStatus {
                        floor_id: floor_id.clone(),
                        status: "idle".to_string(),
                        current_tool: String::new(),
                        subagent_count: 0,
                    });
                }
                continue;
            }

            // Read the state file
            let content = match tokio::fs::read_to_string(&file_path).await {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Only broadcast if content changed
            if last_states.get(floor_id).map(|s| s.as_str()) == Some(&content) {
                continue;
            }

            // Parse the state file
            let state_file: ClaudeStateFile = match serde_json::from_str(&content) {
                Ok(s) => s,
                Err(e) => {
                    warn!(floor_id = %floor_id, error = %e, "Failed to parse state file");
                    continue;
                }
            };

            last_states.insert(floor_id.clone(), content);

            let _ = state.status_tx.send(ServerMessage::SessionStatus {
                floor_id: floor_id.clone(),
                status: state_file.status,
                current_tool: state_file.current_tool.unwrap_or_default(),
                subagent_count: state_file.subagent_count.unwrap_or(0),
            });
        }
    }
}

/// Wait for Ctrl+C to trigger graceful shutdown.
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C handler");
    info!("Shutdown signal received, stopping server...");
}
