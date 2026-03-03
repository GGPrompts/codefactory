mod config;
mod log_layer;
mod state;
mod terminal;
mod ws;

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
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
    // Initialize tracing with layered subscriber (fmt + log broadcast)
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let (log_tx, _) = tokio::sync::broadcast::channel::<ServerMessage>(256);
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            "codefactory_backend=info,warn".parse().unwrap()
        });
    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(log_layer::LogBroadcastLayer {
            log_tx: log_tx.clone(),
        })
        .init();

    // Load profile config (creates defaults if missing)
    let profile_config = config::load_config().unwrap_or_else(|e| {
        warn!("Failed to load profile config: {e}, using defaults");
        ProfileConfig::default()
    });

    info!(
        profiles = profile_config.profiles.len(),
        "Profile config loaded"
    );

    // Shared application state (uses pre-created log_tx so tracing layer shares it)
    let app_state = Arc::new(AppState::new_with_log_tx(profile_config, log_tx));

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
        .route("/api/pages/{*name}", get(get_page))
        .route("/api/git/graph", get(git_graph))
        .route("/api/git/commit/{hash}", get(git_commit_details))
        .route("/api/git/diff", get(git_diff))
        .route("/api/git/status", get(git_status))
        .route("/api/git/fetch", post(git_fetch))
        .route("/api/git/pull", post(git_pull))
        .route("/api/git/push", post(git_push))
        .route("/api/git/stage", post(git_stage))
        .route("/api/git/unstage", post(git_unstage))
        .route("/api/git/commit", post(git_commit_action))
        .route("/api/git/generate-message", post(git_generate_message))
        .route("/api/beads/issues", get(beads_issues))
        // Terminal capture endpoint
        .route("/api/terminal/{session}/capture", get(terminal_capture))
        // Termux API endpoints
        .route("/api/termux/battery", get(termux_battery))
        .route("/api/termux/wifi", get(termux_wifi))
        .route("/api/termux/volume", get(termux_volume))
        .route("/api/termux/brightness", post(termux_brightness))
        .route("/api/termux/torch", post(termux_torch))
        .route("/api/termux/tts", post(termux_tts))
        // Server control
        .route("/api/shutdown", post(shutdown_server))
        // Log system endpoints
        .route("/api/logs/ingest", post(logs_ingest))
        .route("/api/logs", get(get_logs))
        .route("/ws/logs", get(ws_logs_handler))
        .route("/ws/livereload", get(ws_livereload_handler))
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
    tokio::spawn(async move {
        // Give the server a moment to fully start
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        match tokio::task::spawn_blocking(|| {
            crate::terminal::TerminalManager::list_tmux_sessions()
        }).await {
            Ok(Ok(orphans)) if !orphans.is_empty() => {
                info!("Found {} orphaned tmux sessions available for reconnection: {:?}", orphans.len(), orphans);
            }
            Ok(Ok(_)) => {
                info!("No orphaned tmux sessions found");
            }
            Ok(Err(e)) => {
                warn!("Failed to check for orphaned sessions: {}", e);
            }
            Err(e) => {
                warn!("spawn_blocking panicked checking orphaned sessions: {}", e);
            }
        }
    });

    // Session status poller: reads Claude state files and broadcasts changes
    let poller_state = app_state.clone();
    tokio::spawn(async move {
        session_status_poller(poller_state).await;
    });

    // File change poller: watches frontend files and broadcasts changes for live reload
    let reload_state = app_state.clone();
    tokio::spawn(async move {
        file_change_poller(reload_state).await;
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

    // Build a response that includes a stable `id` derived from the profile name.
    // This ensures tmux sessions stay mapped correctly when profiles are reordered or inserted.
    let profiles_with_id: Vec<serde_json::Value> = config
        .profiles
        .iter()
        .map(|p| {
            let slug = p.name.to_lowercase()
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '-' })
                .collect::<String>()
                .split('-')
                .filter(|s| !s.is_empty())
                .collect::<Vec<&str>>()
                .join("-");
            serde_json::json!({
                "id": slug,
                "name": p.name,
                "command": p.command,
                "cwd": p.cwd,
                "icon": p.icon,
                "panel": p.panel,
                "page": p.page,
                "panels": p.panels,
                "enabled": p.enabled,
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

/// List tmux sessions available for reconnection.
async fn get_sessions(
    State(_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let sessions = tokio::task::spawn_blocking(|| {
        crate::terminal::TerminalManager::list_tmux_sessions().unwrap_or_default()
    }).await.unwrap_or_default();
    (StatusCode::OK, Json(SessionsResponse { sessions }))
}

/// Return current Claude session status for all floors (polled from state files).
/// Scans all .json files in the state directory (not just floor-matched ones)
/// so the terminals dashboard can show every active Claude session.
async fn get_session_status(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let claude_floors = claude_floor_ids(&state);
    let state_dir = std::path::Path::new("/tmp/claude-code-state");
    let mut statuses = Vec::new();

    // Scan all state files — they may be named by session hash, not floor ID.
    // Skip files older than 5 minutes to filter out stale sessions.
    let stale_threshold = std::time::Duration::from_secs(300);
    if let Ok(entries) = std::fs::read_dir(state_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            // Skip non-json, context files, and directories
            if !name.ends_with(".json") || name.contains("-context") {
                continue;
            }
            // Skip stale files
            if let Ok(meta) = path.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified.elapsed().unwrap_or_default() > stale_threshold {
                        continue;
                    }
                }
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(sf) = serde_json::from_str::<ClaudeStateFile>(&content) {
                    let session_key = name.trim_end_matches(".json").to_string();
                    statuses.push(serde_json::json!({
                        "floorId": session_key,
                        "sessionId": sf.session_id,
                        "status": sf.status,
                        "currentTool": sf.current_tool.unwrap_or_default(),
                        "subagentCount": sf.subagent_count.unwrap_or(0),
                        "contextPercent": sf.context_percent,
                        "contextWindow": sf.context_window,
                        "workingDir": sf.working_dir,
                        "details": sf.details,
                        "lastUpdated": sf.last_updated,
                    }));
                }
            }
        }
    }

    // Include profile info so dashboard pages can get everything in one call.
    // Collect everything from the config lock in a single block, then drop
    // the guard before any .await points.
    let (profiles, profile_snapshot): (Vec<serde_json::Value>, Vec<(String, String, String, String)>) = {
        let config = state.profile_config.read().unwrap();
        let profiles = config
            .profiles
            .iter()
            .enumerate()
            .map(|(i, p)| {
                serde_json::json!({
                    "floorIndex": i + 1,
                    "name": p.name,
                    "icon": p.icon,
                    "command": p.command,
                    "enabled": p.enabled,
                    "isPage": p.page.is_some(),
                })
            })
            .collect();
        let snapshot = config
            .profiles
            .iter()
            .map(|p| {
                let slug = p.name.to_lowercase()
                    .chars()
                    .map(|c| if c.is_alphanumeric() { c } else { '-' })
                    .collect::<String>()
                    .split('-')
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<&str>>()
                    .join("-");
                (slug, p.name.clone(), p.icon.clone().unwrap_or_default(), p.command.clone().unwrap_or_default())
            })
            .collect();
        (profiles, snapshot)
    }; // config guard dropped here

    // List all active codefactory tmux sessions (spawn_blocking to avoid
    // blocking tokio — list_orphaned_sessions calls std::process::Command).
    let orphaned = tokio::task::spawn_blocking(|| {
        crate::terminal::TerminalManager::list_tmux_sessions().unwrap_or_default()
    }).await.unwrap_or_default();
    let active_floors: Vec<serde_json::Value> = orphaned
        .into_iter()
        .map(|floor_id| {
            let (name, icon, command) = profile_snapshot
                .iter()
                .find(|(slug, _, _, _)| *slug == floor_id)
                .map(|(_, name, icon, cmd)| (name.clone(), icon.clone(), cmd.clone()))
                .unwrap_or_else(|| (floor_id.clone(), String::new(), String::new()));
            serde_json::json!({
                "floorId": floor_id,
                "name": name,
                "icon": icon,
                "command": command,
                "online": true,
            })
        })
        .collect();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "statuses": statuses,
            "claudeFloors": claude_floors,
            "profiles": profiles,
            "activeFloors": active_floors,
        })),
    )
}

/// Serve a raw markdown file.
/// If the name contains `/` or starts with `~`, treat it as an absolute path
/// (with tilde expansion). Otherwise look it up in `~/.config/codefactory/panels/`.
async fn get_panel(Path(name): Path<String>) -> impl IntoResponse {
    // Wildcard captures may include a leading slash — strip it
    let name = name.strip_prefix('/').unwrap_or(&name).to_string();

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

/// Serve a raw HTML page file.
/// Same path resolution as `get_panel` but returns `text/html`.
async fn get_page(Path(name): Path<String>) -> impl IntoResponse {
    let name = name.strip_prefix('/').unwrap_or(&name).to_string();

    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "text/plain")],
            "Invalid page name".to_string(),
        );
    }

    let file_path = if name.starts_with('~') || name.starts_with('/') {
        std::path::PathBuf::from(config::expand_tilde(&name))
    } else {
        let sanitized = name
            .replace('/', "")
            .replace('\\', "")
            .replace("..", "");
        // Try user config dir first, then fall back to bundled frontend/pages/
        let config_path = std::path::PathBuf::from(config::expand_tilde("~/.config/codefactory/pages")).join(&sanitized);
        if tokio::fs::metadata(&config_path).await.map(|m| m.is_file()).unwrap_or(false) {
            config_path
        } else {
            std::path::PathBuf::from("frontend/pages").join(&sanitized)
        }
    };

    match tokio::fs::metadata(&file_path).await {
        Ok(meta) if meta.is_file() => {}
        _ => {
            return (
                StatusCode::NOT_FOUND,
                [("content-type", "text/plain")],
                format!("Page '{}' not found", name),
            );
        }
    }

    match tokio::fs::read_to_string(&file_path).await {
        Ok(content) => (
            StatusCode::OK,
            [("content-type", "text/html; charset=utf-8")],
            content,
        ),
        Err(_) => (
            StatusCode::NOT_FOUND,
            [("content-type", "text/plain")],
            format!("Page '{}' not found", name),
        ),
    }
}

// ── Server Control ───────────────────────────────────────────────────────

/// POST /api/shutdown — gracefully exit the server process.
async fn shutdown_server() -> impl IntoResponse {
    info!("Shutdown requested via API");
    // Spawn a task to exit after a brief delay so the response can be sent
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        std::process::exit(0);
    });
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

// ── Log System ───────────────────────────────────────────────────────────

/// Append a log entry to the ring buffer, broadcast, and write to log file.
fn emit_log_entry(state: &AppState, entry: ServerMessage) {
    // Push to ring buffer (cap at 500)
    if let Ok(mut logs) = state.logs.write() {
        if logs.len() >= 500 {
            logs.pop_front();
        }
        logs.push_back(entry.clone());
    }

    // Broadcast to /ws/logs subscribers
    let _ = state.log_tx.send(entry.clone());

    // Append to log file for tail -f
    if let ServerMessage::LogEntry {
        ref level,
        ref source,
        ref message,
        ref timestamp,
        ..
    } = entry
    {
        let time = if timestamp.len() >= 19 {
            &timestamp[11..19]
        } else {
            "??:??:??"
        };
        let line = format!(
            "[{}] [{:5}] [{:7}] {}\n",
            time,
            level.to_uppercase(),
            source.to_uppercase(),
            message
        );
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/codefactory.log")
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[derive(Deserialize)]
struct IngestEntry {
    level: String,
    message: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    stack: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

/// POST /api/logs/ingest — accept batched log entries from the frontend console forwarder.
async fn logs_ingest(
    State(state): State<Arc<AppState>>,
    Json(entries): Json<Vec<IngestEntry>>,
) -> impl IntoResponse {
    for entry in entries {
        let level = match entry.level.as_str() {
            "error" | "warn" | "info" | "debug" | "log" => entry.level.clone(),
            _ => "log".to_string(),
        };
        let source = entry.source.unwrap_or_else(|| "js".to_string());
        let timestamp = entry.timestamp.unwrap_or_else(|| {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            format!("{}Z", secs)
        });

        let msg = ServerMessage::LogEntry {
            level,
            source,
            message: entry.message,
            stack: entry.stack,
            timestamp,
        };
        emit_log_entry(&state, msg);
    }

    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct LogsParams {
    limit: Option<usize>,
}

/// GET /api/logs?limit=N — return last N log entries from the ring buffer.
async fn get_logs(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LogsParams>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(200).min(500);
    let logs = state.logs.read().unwrap();
    let start = if logs.len() > limit { logs.len() - limit } else { 0 };
    let entries: Vec<&ServerMessage> = logs.iter().skip(start).collect();
    (StatusCode::OK, Json(serde_json::json!({ "logs": entries })))
}

/// WebSocket handler for the live log stream.
async fn ws_logs_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_logs_socket(socket, state))
}

async fn handle_logs_socket(
    socket: axum::extract::ws::WebSocket,
    state: Arc<AppState>,
) {
    use axum::extract::ws::Message;
    use futures::{SinkExt, StreamExt};

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let mut log_rx = state.log_tx.subscribe();

    // Send connection confirmation
    let connected = serde_json::to_string(&ServerMessage::Connected).unwrap_or_default();
    let _ = ws_sender.send(Message::Text(connected.into())).await;

    loop {
        tokio::select! {
            result = log_rx.recv() => {
                match result {
                    Ok(msg) => {
                        if let Ok(json) = serde_json::to_string(&msg) {
                            if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!("ws/logs client lagged by {} messages", n);
                    }
                    Err(_) => break,
                }
            }
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

// ── Live Reload WebSocket + File Poller ───────────────────────────────────

async fn ws_livereload_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_livereload_socket(socket, state))
}

async fn handle_livereload_socket(
    socket: axum::extract::ws::WebSocket,
    state: Arc<AppState>,
) {
    use axum::extract::ws::Message;
    use futures::{SinkExt, StreamExt};

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let mut reload_rx = state.reload_tx.subscribe();

    let connected = serde_json::to_string(&ServerMessage::Connected).unwrap_or_default();
    let _ = ws_sender.send(Message::Text(connected.into())).await;

    loop {
        tokio::select! {
            result = reload_rx.recv() => {
                match result {
                    Ok(msg) => {
                        if let Ok(json) = serde_json::to_string(&msg) {
                            if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!("ws/livereload client lagged by {} messages", n);
                    }
                    Err(_) => break,
                }
            }
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

/// Polls frontend files for mtime changes and broadcasts FileChanged messages.
async fn file_change_poller(state: Arc<AppState>) {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::SystemTime;

    let scan_dirs: Vec<PathBuf> = vec![
        "frontend/css".into(),
        "frontend/js".into(),
        "frontend/pages".into(),
    ];
    let scan_root = PathBuf::from("frontend");

    // Collect initial mtimes
    let mut mtimes: HashMap<PathBuf, SystemTime> = HashMap::new();
    for path in collect_frontend_files(&scan_dirs, &scan_root) {
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(mtime) = meta.modified() {
                mtimes.insert(path, mtime);
            }
        }
    }

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        // Run blocking filesystem scan off the tokio worker thread.
        let dirs = scan_dirs.clone();
        let root = scan_root.clone();
        let prev = mtimes.clone();
        let changes = tokio::task::spawn_blocking(move || {
            let mut changed_files: Vec<(PathBuf, SystemTime, String)> = Vec::new();
            let current_files = collect_frontend_files(&dirs, &root);
            for path in &current_files {
                let current_mtime = match std::fs::metadata(path).and_then(|m| m.modified()) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let changed = match prev.get(path) {
                    Some(&prev_t) => current_mtime != prev_t,
                    None => true,
                };
                if changed {
                    let rel = path.to_string_lossy().to_string();
                    let change_type = classify_change(&rel);
                    changed_files.push((path.clone(), current_mtime, change_type));
                }
            }
            changed_files
        }).await.unwrap_or_default();

        for (path, mtime, change_type) in changes {
            mtimes.insert(path.clone(), mtime);
            let rel = path.to_string_lossy().to_string();
            info!(path = %rel, change_type = %change_type, "Frontend file changed");
            let _ = state.reload_tx.send(ServerMessage::FileChanged {
                path: rel,
                change_type,
            });
        }
    }
}

fn collect_frontend_files(
    scan_dirs: &[std::path::PathBuf],
    scan_root: &std::path::Path,
) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();

    // Scan subdirectories recursively
    for dir in scan_dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    files.push(path);
                }
            }
        }
    }

    // Scan root-level HTML files (e.g., frontend/index.html)
    if let Ok(entries) = std::fs::read_dir(scan_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "html" {
                        files.push(path);
                    }
                }
            }
        }
    }

    files
}

fn classify_change(path: &str) -> String {
    if path.ends_with(".css") {
        "css".into()
    } else if path.contains("pages/") && path.ends_with(".html") {
        "page".into()
    } else if path.ends_with(".js") {
        "js".into()
    } else if path.ends_with(".html") {
        "html".into()
    } else {
        "other".into()
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
    context_percent: Option<u32>,
    context_window: Option<serde_json::Value>,
    working_dir: Option<String>,
    details: Option<serde_json::Value>,
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

// ── Git API Endpoints ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitGraphParams {
    path: Option<String>,
    limit: Option<usize>,
    skip: Option<usize>,
}

/// Resolve a path, expanding `~` to `$HOME`.
fn expand_path(raw: &str) -> String {
    if raw.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{}{}", home, &raw[1..]);
        }
    }
    raw.to_string()
}

/// Walk upward from `start` to find the git repository root.
fn find_git_root(start: &str) -> Option<String> {
    let mut path = std::path::PathBuf::from(start);
    loop {
        if path.join(".git").exists() {
            return Some(path.to_string_lossy().to_string());
        }
        if !path.pop() {
            return None;
        }
    }
}

/// GET /api/git/graph?path=&limit=&skip=
/// Returns commit graph data for visualization.
async fn git_graph(Query(params): Query<GitGraphParams>) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "path parameter required"})),
            );
        }
    };

    let expanded = expand_path(&raw_path);
    let git_root = match find_git_root(&expanded) {
        Some(r) => r,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "not a git repository"})),
            );
        }
    };

    let limit = params.limit.unwrap_or(50);
    let skip = params.skip.unwrap_or(0);

    // Request limit+1 to detect hasMore
    let format_str = "%H|%h|%an|%ae|%aI|%P|%D|%s";
    let output = tokio::process::Command::new("git")
        .args([
            "-C",
            &git_root,
            "log",
            "--all",
            &format!("--format={}", format_str),
            &format!("-n{}", limit + 1),
            &format!("--skip={}", skip),
        ])
        .output()
        .await;

    let output = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("git log failed: {}", stderr)})),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("failed to run git: {}", e)})),
            );
        }
    };

    let mut commits: Vec<serde_json::Value> = Vec::new();
    for line in output.trim().lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(8, '|').collect();
        if parts.len() < 8 {
            continue;
        }

        let parents: Vec<&str> = if parts[5].is_empty() {
            Vec::new()
        } else {
            parts[5].split_whitespace().collect()
        };

        let refs: Vec<&str> = if parts[6].is_empty() {
            Vec::new()
        } else {
            parts[6].split(", ").map(|s| s.trim()).collect()
        };

        commits.push(serde_json::json!({
            "hash": parts[0],
            "shortHash": parts[1],
            "author": parts[2],
            "email": parts[3],
            "date": parts[4],
            "parents": parents,
            "refs": refs,
            "message": parts[7],
        }));
    }

    let has_more = commits.len() > limit;
    if has_more {
        commits.truncate(limit);
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "data": {
                "commits": commits,
                "hasMore": has_more,
            }
        })),
    )
}

#[derive(Deserialize)]
struct GitCommitParams {
    path: Option<String>,
}

/// GET /api/git/commit/:hash?path=
/// Returns detailed commit info including changed files.
async fn git_commit_details(
    Path(hash): Path<String>,
    Query(params): Query<GitCommitParams>,
) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "path parameter required"})),
            );
        }
    };

    let expanded = expand_path(&raw_path);
    let git_root = match find_git_root(&expanded) {
        Some(r) => r,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "not a git repository"})),
            );
        }
    };

    // Get commit info with body
    let format_str = "%H|%h|%an|%ae|%aI|%P|%D|%s|%b";
    let output = tokio::process::Command::new("git")
        .args(["-C", &git_root, "log", "-1", &format!("--format={}", format_str), &hash])
        .output()
        .await;

    let commit_line = match output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "commit not found"})),
                );
            }
            s
        }
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "commit not found"})),
            );
        }
    };

    let parts: Vec<&str> = commit_line.splitn(9, '|').collect();
    if parts.len() < 9 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "failed to parse commit"})),
        );
    }

    let parents: Vec<&str> = if parts[5].is_empty() {
        Vec::new()
    } else {
        parts[5].split_whitespace().collect()
    };

    let refs: Vec<&str> = if parts[6].is_empty() {
        Vec::new()
    } else {
        parts[6].split(", ").map(|s| s.trim()).collect()
    };

    let body = parts[8].trim();

    // Get changed files via name-status
    let status_output = tokio::process::Command::new("git")
        .args(["-C", &git_root, "diff-tree", "--no-commit-id", "--name-status", "-r", &hash])
        .output()
        .await;

    // Get numstat for additions/deletions
    let numstat_output = tokio::process::Command::new("git")
        .args(["-C", &git_root, "diff-tree", "--no-commit-id", "--numstat", "-r", &hash])
        .output()
        .await;

    // Parse name-status into a map
    let mut status_map = std::collections::HashMap::new();
    if let Ok(o) = &status_output {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.trim().lines() {
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() >= 2 {
                    let status = fields[0];
                    let path = if status.starts_with('R') && fields.len() >= 3 {
                        fields[2]
                    } else {
                        fields[1]
                    };
                    // Take just the first character of status (R100 -> R)
                    status_map.insert(
                        path.to_string(),
                        status.chars().next().unwrap_or('M').to_string(),
                    );
                }
            }
        }
    }

    // Parse numstat to build file list
    let mut files: Vec<serde_json::Value> = Vec::new();
    if let Ok(o) = &numstat_output {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.trim().lines() {
                if line.is_empty() {
                    continue;
                }
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() < 3 {
                    continue;
                }
                let additions: i64 = fields[0].parse().unwrap_or(0);
                let deletions: i64 = fields[1].parse().unwrap_or(0);
                let mut file_path = fields[2].to_string();

                // Handle renames: {old => new} or old => new
                if file_path.contains("=>") {
                    let after = file_path.split("=>").last().unwrap_or("").trim();
                    file_path = after.trim_end_matches('}').to_string();
                }

                let status = status_map
                    .get(&file_path)
                    .cloned()
                    .unwrap_or_else(|| "M".to_string());

                files.push(serde_json::json!({
                    "path": file_path,
                    "status": status,
                    "additions": additions,
                    "deletions": deletions,
                }));
            }
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "data": {
                "hash": parts[0],
                "shortHash": parts[1],
                "author": parts[2],
                "email": parts[3],
                "date": parts[4],
                "parents": parents,
                "refs": refs,
                "message": parts[7],
                "body": if body.is_empty() { None } else { Some(body) },
                "files": files,
            }
        })),
    )
}

#[derive(Deserialize)]
struct GitDiffParams {
    path: Option<String>,
    base: Option<String>,
    file: Option<String>,
}

/// GET /api/git/diff?path=&base=&file=
/// Returns raw diff text for a commit's file.
async fn git_diff(Query(params): Query<GitDiffParams>) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                [("content-type", "application/json")],
                r#"{"error":"path parameter required"}"#.to_string(),
            );
        }
    };

    let expanded = expand_path(&raw_path);
    let git_root = match find_git_root(&expanded) {
        Some(r) => r,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                [("content-type", "application/json")],
                r#"{"error":"not a git repository"}"#.to_string(),
            );
        }
    };

    let base = params.base.unwrap_or_default();
    let file = params.file.unwrap_or_default();

    let mut args = vec!["-C".to_string(), git_root.clone(), "diff".to_string()];

    if !base.is_empty() {
        if base == "HEAD" {
            args.push("HEAD".to_string());
        } else {
            args.push(format!("{}^", base));
            args.push(base.clone());
        }
    }

    if !file.is_empty() {
        args.push("--".to_string());
        args.push(file.clone());
    }

    let output = tokio::process::Command::new("git")
        .args(&args)
        .output()
        .await;

    let diff_text = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => {
            // Fallback for first commit (no parent): use git show
            if !base.is_empty() && base != "HEAD" {
                let mut show_args = vec![
                    "-C".to_string(),
                    git_root,
                    "show".to_string(),
                    base,
                    "--format=".to_string(),
                ];
                if !file.is_empty() {
                    show_args.push("--".to_string());
                    show_args.push(file.clone());
                }
                match tokio::process::Command::new("git")
                    .args(&show_args)
                    .output()
                    .await
                {
                    Ok(o) if o.status.success() => {
                        String::from_utf8_lossy(&o.stdout).to_string()
                    }
                    _ => String::new(),
                }
            } else {
                String::new()
            }
        }
    };

    let body = serde_json::json!({
        "data": {
            "diff": diff_text,
            "filePath": file,
        }
    });

    (
        StatusCode::OK,
        [("content-type", "application/json")],
        body.to_string(),
    )
}

// ── Git Status Endpoint ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitStatusParams {
    path: Option<String>,
}

/// GET /api/git/status?path=
/// Returns branch, ahead/behind, staged, unstaged, and untracked files.
async fn git_status(Query(params): Query<GitStatusParams>) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "path parameter required"})),
            );
        }
    };

    let expanded = expand_path(&raw_path);
    let git_root = match find_git_root(&expanded) {
        Some(r) => r,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "not a git repository"})),
            );
        }
    };

    // --- git status --porcelain=v1 -b ---
    let status_output = tokio::process::Command::new("git")
        .args(["-C", &git_root, "status", "--porcelain=v1", "-b"])
        .output()
        .await;

    let status_text = match status_output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("git status failed: {}", stderr)})),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("failed to run git: {}", e)})),
            );
        }
    };

    let mut branch = String::new();
    let mut remote_branch: Option<String> = None;
    let mut staged: Vec<serde_json::Value> = Vec::new();
    let mut unstaged: Vec<serde_json::Value> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();

    for line in status_text.lines() {
        if line.starts_with("## ") {
            // Parse branch line: "## main...origin/main" or "## HEAD (no branch)"
            let branch_info = &line[3..];
            if let Some(dots) = branch_info.find("...") {
                branch = branch_info[..dots].to_string();
                // Remote part may have trailing info like " [ahead 2, behind 1]"
                let rest = &branch_info[dots + 3..];
                if let Some(space) = rest.find(' ') {
                    remote_branch = Some(rest[..space].to_string());
                } else {
                    remote_branch = Some(rest.to_string());
                }
            } else {
                // No remote tracking, may have " [gone]" etc.
                if let Some(space) = branch_info.find(' ') {
                    branch = branch_info[..space].to_string();
                } else {
                    branch = branch_info.to_string();
                }
            }
            continue;
        }

        if line.len() < 4 {
            continue;
        }

        let index_status = line.as_bytes()[0] as char;
        let worktree_status = line.as_bytes()[1] as char;
        // File path starts at position 3
        let file_path = &line[3..];
        // Handle renames: "R  old -> new" — use the new name
        let display_path = if let Some(arrow) = file_path.find(" -> ") {
            &file_path[arrow + 4..]
        } else {
            file_path
        };

        if index_status == '?' && worktree_status == '?' {
            untracked.push(display_path.to_string());
            continue;
        }

        // Staged changes (index column)
        if index_status != ' ' && index_status != '?' {
            let code = match index_status {
                'M' => "M",
                'A' => "A",
                'D' => "D",
                'R' => "R",
                'C' => "A", // copied, treat as added
                _ => "M",
            };
            staged.push(serde_json::json!({"path": display_path, "status": code}));
        }

        // Unstaged changes (worktree column)
        if worktree_status != ' ' && worktree_status != '?' {
            let code = match worktree_status {
                'M' => "M",
                'D' => "D",
                _ => "M",
            };
            unstaged.push(serde_json::json!({"path": display_path, "status": code}));
        }
    }

    // --- ahead/behind via rev-list ---
    let mut ahead: i64 = 0;
    let mut behind: i64 = 0;

    if remote_branch.is_some() {
        let revlist = tokio::process::Command::new("git")
            .args([
                "-C",
                &git_root,
                "rev-list",
                "--left-right",
                "--count",
                "HEAD...@{upstream}",
            ])
            .output()
            .await;

        if let Ok(o) = revlist {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                let parts: Vec<&str> = text.trim().split('\t').collect();
                if parts.len() == 2 {
                    ahead = parts[0].parse().unwrap_or(0);
                    behind = parts[1].parse().unwrap_or(0);
                }
            }
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "branch": branch,
            "remote_branch": remote_branch.unwrap_or_default(),
            "ahead": ahead,
            "behind": behind,
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
        })),
    )
}

// ── Git Action Endpoints ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitActionParams {
    path: Option<String>,
}

/// Helper: resolve git root from a `?path=` query param.
fn resolve_git_root(path: Option<String>) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let raw_path = match path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "path parameter required"})),
            ));
        }
    };
    let expanded = expand_path(&raw_path);
    match find_git_root(&expanded) {
        Some(r) => Ok(r),
        None => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "not a git repository"})),
        )),
    }
}

/// Helper: run a git command in a given directory and return success/error JSON.
async fn run_git_command(git_root: &str, args: &[&str]) -> (StatusCode, Json<serde_json::Value>) {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(git_root)
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            (
                StatusCode::OK,
                Json(serde_json::json!({"success": true, "output": stdout.trim()})),
            )
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            (
                StatusCode::OK,
                Json(serde_json::json!({"success": false, "error": stderr.trim()})),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"success": false, "error": format!("failed to run git: {}", e)})),
        ),
    }
}

/// POST /api/git/fetch?path=
async fn git_fetch(Query(params): Query<GitActionParams>) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };
    run_git_command(&git_root, &["fetch"]).await
}

/// POST /api/git/pull?path=
async fn git_pull(Query(params): Query<GitActionParams>) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };
    run_git_command(&git_root, &["pull"]).await
}

/// POST /api/git/push?path=
async fn git_push(Query(params): Query<GitActionParams>) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };
    run_git_command(&git_root, &["push"]).await
}

#[derive(Deserialize)]
struct GitStageBody {
    files: Option<Vec<String>>,
    all: Option<bool>,
}

/// POST /api/git/stage?path= — body: {"files": [...]} or {"all": true}
async fn git_stage(
    Query(params): Query<GitActionParams>,
    Json(body): Json<GitStageBody>,
) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };

    if body.all.unwrap_or(false) {
        return run_git_command(&git_root, &["add", "-A"]).await;
    }

    match &body.files {
        Some(files) if !files.is_empty() => {
            let mut args: Vec<&str> = vec!["add", "--"];
            for f in files {
                args.push(f.as_str());
            }
            run_git_command(&git_root, &args).await
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "files array or all:true required"})),
        ),
    }
}

/// POST /api/git/unstage?path= — body: {"files": [...]} or {"all": true}
async fn git_unstage(
    Query(params): Query<GitActionParams>,
    Json(body): Json<GitStageBody>,
) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };

    if body.all.unwrap_or(false) {
        return run_git_command(&git_root, &["reset", "HEAD"]).await;
    }

    match &body.files {
        Some(files) if !files.is_empty() => {
            let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
            for f in files {
                args.push(f.as_str());
            }
            run_git_command(&git_root, &args).await
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "files array or all:true required"})),
        ),
    }
}

#[derive(Deserialize)]
struct GitCommitBody {
    message: String,
}

/// POST /api/git/commit?path= — body: {"message": "..."}
async fn git_commit_action(
    Query(params): Query<GitActionParams>,
    Json(body): Json<GitCommitBody>,
) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };

    if body.message.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "commit message required"})),
        );
    }

    run_git_command(&git_root, &["commit", "-m", &body.message]).await
}

/// POST /api/git/generate-message?path= — generate commit message via Claude Haiku
async fn git_generate_message(Query(params): Query<GitActionParams>) -> impl IntoResponse {
    let git_root = match resolve_git_root(params.path) {
        Ok(r) => r,
        Err(e) => return e,
    };

    // Get staged diff
    let diff_output = tokio::process::Command::new("git")
        .args(["-C", &git_root, "diff", "--cached"])
        .output()
        .await;

    let diff = match diff_output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            if s.trim().is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"success": false, "error": "no_staged_changes"})),
                );
            }
            s
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": stderr.trim()})),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": format!("failed to run git: {}", e)})),
            );
        }
    };

    // Truncate at 50KB
    let max_len = 50 * 1024;
    let truncated_diff = if diff.len() > max_len {
        let mut end = max_len;
        // Don't cut in the middle of a multi-byte char
        while end > 0 && !diff.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n\n[diff truncated at 50KB]", &diff[..end])
    } else {
        diff
    };

    let prompt = format!(
        "Write a git commit message for this diff.\n\n\
         OUTPUT RULES:\n\
         - Output ONLY the commit message, nothing else\n\
         - NO markdown, backticks, XML tags, or preamble\n\
         - NO Co-Authored-By lines\n\n\
         FORMAT:\n\
         - Conventional commit prefix: feat:, fix:, refactor:, docs:, chore:\n\
         - First line under 72 chars\n\
         - Optional blank line + bullet points for details\n\n\
         DIFF:\n{}",
        truncated_diff
    );

    // Spawn claude with 30s timeout
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let child = tokio::process::Command::new("claude")
        .args(["--model", "haiku", "--print", "-p", "-"])
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_SESSION")
        .env_remove("CLAUDE_SESSION_ID")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .env_remove("CLAUDE_CODE_TMPDIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::OK,
                Json(serde_json::json!({"success": false, "error": "claude_not_available"})),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": format!("failed to spawn claude: {}", e)})),
            );
        }
    };

    // Write prompt to stdin
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);
    }

    // Wait with 60s timeout (CLI startup + API call can be slow on mobile)
    let timeout = std::time::Duration::from_secs(60);
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (
                StatusCode::OK,
                Json(serde_json::json!({"success": true, "message": message})),
            )
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": stderr.trim()})),
            )
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"success": false, "error": format!("claude process error: {}", e)})),
        ),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({"success": false, "error": "timeout generating commit message"})),
        ),
    }
}

// ── Beads API Endpoint ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct BeadsIssuesParams {
    path: Option<String>,
}

/// GET /api/beads/issues?path=
/// Shells out to `bd list --json --status=all` in the given directory and
/// forwards the parsed JSON array as `{ "issues": [...] }`.
async fn beads_issues(Query(params): Query<BeadsIssuesParams>) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => ".".to_string(),
    };

    let expanded = expand_path(&raw_path);

    let output = tokio::process::Command::new("bd")
        .args(["list", "--json", "--status=all", "--limit", "0"])
        .current_dir(&expanded)
        .output()
        .await;

    let output = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("bd list failed: {}", stderr)})),
            );
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("failed to run bd: {}", e)})),
            );
        }
    };

    let issues: serde_json::Value = match serde_json::from_str(&output) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("failed to parse bd output: {}", e)})),
            );
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({ "issues": issues })),
    )
}

// ── Terminal Capture Endpoint ─────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct CaptureParams {
    lines: Option<u32>,
}

async fn terminal_capture(
    Path(session): Path<String>,
    Query(params): Query<CaptureParams>,
) -> impl IntoResponse {
    let lines = params.lines.unwrap_or(200);
    let tmux_session = format!("codefactory-floor-{session}");
    let start_arg = format!("-{lines}");

    let output = tokio::process::Command::new("tmux")
        .args(["capture-pane", "-p", "-t", &tmux_session, "-S", &start_arg])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout).to_string();
            (
                StatusCode::OK,
                [("content-type", "text/plain; charset=utf-8")],
                body,
            )
                .into_response()
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            if stderr.contains("can't find") || stderr.contains("no such session") {
                (
                    StatusCode::NOT_FOUND,
                    [("content-type", "text/plain; charset=utf-8")],
                    format!("session '{}' not found", tmux_session),
                )
                    .into_response()
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    [("content-type", "text/plain; charset=utf-8")],
                    format!("tmux capture failed: {}", stderr),
                )
                    .into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("content-type", "text/plain; charset=utf-8")],
            format!("failed to run tmux: {}", e),
        )
            .into_response(),
    }
}

// ── Termux API Endpoints ───────────────────────────────────────────────────

/// Helper: run a termux-api command and return its stdout as a JSON value.
/// Returns a graceful error if the command is not found (non-Termux system).
async fn run_termux_command(cmd: &str, args: &[&str]) -> Result<serde_json::Value, (StatusCode, Json<serde_json::Value>)> {
    let output = tokio::process::Command::new(cmd)
        .args(args)
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            match serde_json::from_str::<serde_json::Value>(&stdout) {
                Ok(v) => Ok(v),
                Err(_) => Ok(serde_json::json!({ "raw": stdout.trim() })),
            }
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("{} failed: {}", cmd, stderr) })),
            ))
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({
                        "error": format!("{} not found — not running on Termux?", cmd),
                        "available": false
                    })),
                ))
            } else {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": format!("failed to run {}: {}", cmd, e) })),
                ))
            }
        }
    }
}

/// Helper: run a termux-api command that produces no JSON output (fire-and-forget).
async fn run_termux_action(cmd: &str, args: &[&str]) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let output = tokio::process::Command::new(cmd)
        .args(args)
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("{} failed: {}", cmd, stderr) })),
            ))
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({
                        "error": format!("{} not found — not running on Termux?", cmd),
                        "available": false
                    })),
                ))
            } else {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": format!("failed to run {}: {}", cmd, e) })),
                ))
            }
        }
    }
}

/// GET /api/termux/battery — returns battery status JSON.
async fn termux_battery() -> impl IntoResponse {
    match run_termux_command("termux-battery-status", &[]).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => e,
    }
}

/// GET /api/termux/wifi — returns WiFi connection info JSON.
async fn termux_wifi() -> impl IntoResponse {
    match run_termux_command("termux-wifi-connectioninfo", &[]).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => e,
    }
}

/// GET /api/termux/volume — returns volume info JSON (array of streams).
async fn termux_volume() -> impl IntoResponse {
    match run_termux_command("termux-volume", &[]).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct BrightnessBody {
    value: u16,
}

/// POST /api/termux/brightness — set brightness (0-255).
async fn termux_brightness(Json(body): Json<BrightnessBody>) -> impl IntoResponse {
    let value = body.value.min(255);
    let value_str = value.to_string();
    match run_termux_action("termux-brightness", &[&value_str]).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "brightness": value })),
        ),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct TorchBody {
    enabled: bool,
}

/// POST /api/termux/torch — toggle torch on/off.
async fn termux_torch(Json(body): Json<TorchBody>) -> impl IntoResponse {
    let state = if body.enabled { "on" } else { "off" };
    match run_termux_action("termux-torch", &[state]).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "torch": state })),
        ),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct TtsBody {
    text: String,
}

/// POST /api/termux/tts — speak text via TTS.
async fn termux_tts(Json(body): Json<TtsBody>) -> impl IntoResponse {
    if body.text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "text is required" })),
        );
    }

    // termux-tts-speak reads from stdin
    let child = tokio::process::Command::new("termux-tts-speak")
        .stdin(std::process::Stdio::piped())
        .spawn();

    match child {
        Ok(mut c) => {
            if let Some(ref mut stdin) = c.stdin {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(body.text.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
            // Don't wait for TTS to finish — it can take a while
            tokio::spawn(async move {
                let _ = c.wait().await;
            });
            (
                StatusCode::OK,
                Json(serde_json::json!({ "status": "ok", "speaking": true })),
            )
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({
                        "error": "termux-tts-speak not found — not running on Termux?",
                        "available": false
                    })),
                )
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": format!("failed to run termux-tts-speak: {}", e) })),
                )
            }
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
