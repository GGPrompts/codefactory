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
    set_header::SetResponseHeaderLayer,
};
use tracing::{info, warn};

use serde::{Deserialize, Serialize};

/// Returns the temp directory, respecting $TMPDIR (needed for Termux where /tmp is inaccessible).
fn tmp_dir() -> std::path::PathBuf {
    std::env::var("TMPDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
}

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
    // no-cache ensures the browser revalidates on every request (critical for PWA)
    let frontend_dir = ServeDir::new("frontend").fallback(
        tower_http::services::ServeFile::new("frontend/index.html"),
    );
    let no_cache_layer = SetResponseHeaderLayer::overriding(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-cache"),
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
        // File browser endpoints
        .route("/api/files/list", get(files_list))
        .route("/api/files/read", get(files_read))
        .route("/api/files/rename", post(files_rename))
        .route("/api/files/delete", post(files_delete))
        .route("/api/files/create", post(files_create))
        .route("/api/files/diff", get(files_diff))
        // Search endpoints
        .route("/api/search", get(search_query))
        .route("/api/search/replace", post(search_replace))
        // Notes endpoints
        .route("/api/notes/list", get(notes_list))
        .route("/api/notes/read", get(notes_read))
        .route("/api/notes/save", post(notes_save))
        .route("/api/notes/delete", post(notes_delete))
        // Config editor endpoints
        .route("/api/config/list", get(config_list))
        .route("/api/config/read", get(config_read))
        .route("/api/config/write", post(config_write))
        .route("/api/config/env", get(config_env))
        // Terminal capture endpoint
        .route("/api/terminal/{session}/capture", get(terminal_capture))
        // Termux API endpoints
        .route("/api/termux/battery", get(termux_battery))
        .route("/api/termux/wifi", get(termux_wifi))
        .route("/api/termux/volume", get(termux_volume))
        .route("/api/termux/brightness", post(termux_brightness))
        .route("/api/termux/torch", post(termux_torch))
        .route("/api/termux/tts", post(termux_tts))
        // Process manager endpoints
        .route("/api/processes", get(processes_list))
        .route("/api/processes/kill", post(processes_kill))
        // Ports endpoint
        .route("/api/ports", get(ports_list))
        // Server control
        .route("/api/shutdown", post(shutdown_server))
        // Log system endpoints
        .route("/api/logs/ingest", post(logs_ingest))
        .route("/api/logs", get(get_logs))
        .route("/ws/logs", get(ws_logs_handler))
        .route("/ws/livereload", get(ws_livereload_handler))
        .fallback_service(tower::ServiceBuilder::new().layer(no_cache_layer).service(frontend_dir))
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
    let state_dir = tmp_dir().join("claude-code-state");
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
            .open(tmp_dir().join("codefactory.log"))
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

    let state_dir = tmp_dir().join("claude-code-state");
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
    /// Filter issues by ID prefix (e.g. "cf" returns only cf-* issues)
    prefix: Option<String>,
}

/// GET /api/beads/issues?prefix=cf
/// Shells out to ggbd CLI which handles Supabase TLS natively via Go's pgx.
/// Returns `{ "issues": [...] }` wrapping the CLI's JSON array output.
async fn beads_issues(
    Query(params): Query<BeadsIssuesParams>,
) -> impl IntoResponse {
    // Find ggbd binary: alias target first, then PATH
    let ggbd = std::path::PathBuf::from(
        std::env::var("HOME").unwrap_or_default()
    ).join("projects/ggbeads/ggbd");
    let bin = if ggbd.exists() {
        ggbd
    } else {
        std::path::PathBuf::from("bd")
    };

    // Build command: ggbd list --all --json [--prefix X]
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("list").arg("--all").arg("--json");
    if let Some(ref prefix) = params.prefix {
        cmd.arg("--prefix").arg(prefix);
    }
    // Run from a directory that has .beads/ so ggbd finds its config
    let beads_dir = std::path::PathBuf::from(
        std::env::var("HOME").unwrap_or_default()
    ).join("projects/codefactory");
    cmd.current_dir(&beads_dir);
    cmd.env("BD_POSTGRES_URL", std::env::var("BD_POSTGRES_URL").unwrap_or_default());

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("failed to run ggbd: {}", e)})),
            );
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("ggbd failed: {}", stderr.trim())})),
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // ggbd may print warnings to stderr; stdout is the JSON array
    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(issues) => (
            StatusCode::OK,
            Json(serde_json::json!({ "issues": issues })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("failed to parse ggbd output: {}", e)})),
        ),
    }
}

// ── File Browser API Endpoints ────────────────────────────────────────────

#[derive(Deserialize)]
struct FilesListParams {
    path: Option<String>,
    dir: Option<String>,
}

#[derive(Deserialize)]
struct FilesReadParams {
    path: Option<String>,
    file: Option<String>,
}

#[derive(Deserialize)]
struct FilesPathParams {
    path: Option<String>,
}

#[derive(Deserialize)]
struct FilesRenameBody {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct FilesDeleteBody {
    file: String,
}

#[derive(Deserialize)]
struct FilesCreateBody {
    name: String,
    #[serde(rename = "type")]
    entry_type: String, // "file" or "dir"
}

/// GET /api/files/list?path=&dir=
/// List directory contents. `path` is the base/working directory, `dir` is relative subdir.
async fn files_list(Query(params): Query<FilesListParams>) -> impl IntoResponse {
    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded_base = expand_path(&base);
    let full_path = match params.dir {
        Some(ref d) if !d.is_empty() => {
            let p = std::path::PathBuf::from(&expanded_base).join(d);
            p.to_string_lossy().to_string()
        }
        _ => expanded_base.clone(),
    };

    // Canonicalize to resolve symlinks and ..
    let canonical = match tokio::fs::canonicalize(&full_path).await {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("Invalid path: {}", e)})),
            );
        }
    };

    let mut entries = Vec::new();
    let mut read_dir = match tokio::fs::read_dir(&canonical).await {
        Ok(rd) => rd,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Cannot read directory: {}", e)})),
            );
        }
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        entries.push(serde_json::json!({
            "name": name,
            "is_dir": is_dir,
            "size": size,
            "modified": modified,
        }));
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        match (b_dir).cmp(&a_dir) {
            std::cmp::Ordering::Equal => {
                let a_name = a["name"].as_str().unwrap_or("").to_lowercase();
                let b_name = b["name"].as_str().unwrap_or("").to_lowercase();
                a_name.cmp(&b_name)
            }
            other => other,
        }
    });

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "path": canonical.to_string_lossy(),
            "entries": entries,
        })),
    )
}

/// GET /api/files/read?path=&file=
/// Read file contents. Returns text content with detected mime type info.
async fn files_read(Query(params): Query<FilesReadParams>) -> impl IntoResponse {
    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded_base = expand_path(&base);
    let file_name = match params.file {
        Some(ref f) if !f.is_empty() => f.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "file parameter required"})),
            );
        }
    };

    let full_path = std::path::PathBuf::from(&expanded_base).join(&file_name);
    let canonical = match tokio::fs::canonicalize(&full_path).await {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("File not found: {}", e)})),
            );
        }
    };

    let meta = match tokio::fs::metadata(&canonical).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("Cannot stat file: {}", e)})),
            );
        }
    };

    if meta.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Path is a directory, not a file"})),
        );
    }

    // Size limit: 2MB for text preview
    let max_size: u64 = 2 * 1024 * 1024;
    let is_binary;
    let content;

    if meta.len() > max_size {
        is_binary = true;
        content = String::new();
    } else {
        match tokio::fs::read(&canonical).await {
            Ok(bytes) => {
                // Simple binary detection: check first 8KB for null bytes
                let check_len = std::cmp::min(bytes.len(), 8192);
                let has_null = bytes[..check_len].contains(&0);
                if has_null {
                    is_binary = true;
                    content = String::new();
                } else {
                    is_binary = false;
                    content = String::from_utf8_lossy(&bytes).to_string();
                }
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("Cannot read file: {}", e)})),
                );
            }
        }
    }

    let ext = canonical
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "path": canonical.to_string_lossy(),
            "size": meta.len(),
            "is_binary": is_binary,
            "extension": ext,
            "content": content,
        })),
    )
}

/// POST /api/files/rename?path=  body: {from, to}
async fn files_rename(
    Query(params): Query<FilesPathParams>,
    Json(body): Json<FilesRenameBody>,
) -> impl IntoResponse {
    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded = expand_path(&base);
    let from_path = std::path::PathBuf::from(&expanded).join(&body.from);
    let to_path = std::path::PathBuf::from(&expanded).join(&body.to);

    if let Err(e) = tokio::fs::rename(&from_path, &to_path).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Rename failed: {}", e)})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok"})),
    )
}

/// POST /api/files/delete?path=  body: {file}
async fn files_delete(
    Query(params): Query<FilesPathParams>,
    Json(body): Json<FilesDeleteBody>,
) -> impl IntoResponse {
    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded = expand_path(&base);
    let target = std::path::PathBuf::from(&expanded).join(&body.file);

    let meta = match tokio::fs::metadata(&target).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("Not found: {}", e)})),
            );
        }
    };

    let result = if meta.is_dir() {
        tokio::fs::remove_dir_all(&target).await
    } else {
        tokio::fs::remove_file(&target).await
    };

    if let Err(e) = result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Delete failed: {}", e)})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok"})),
    )
}

/// POST /api/files/create?path=  body: {name, type: "file"|"dir"}
async fn files_create(
    Query(params): Query<FilesPathParams>,
    Json(body): Json<FilesCreateBody>,
) -> impl IntoResponse {
    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded = expand_path(&base);
    let target = std::path::PathBuf::from(&expanded).join(&body.name);

    // Check if already exists
    if tokio::fs::metadata(&target).await.is_ok() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "Already exists"})),
        );
    }

    let result = if body.entry_type == "dir" {
        tokio::fs::create_dir_all(&target).await
    } else {
        tokio::fs::write(&target, "").await
    };

    if let Err(e) = result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Create failed: {}", e)})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok"})),
    )
}

/// GET /api/files/diff?path=&a=&b=
/// Diff two arbitrary files using `diff -u`. `path` is base directory, `a` and `b` are file paths
/// (absolute or relative to `path`).
#[derive(Deserialize)]
struct FilesDiffParams {
    path: Option<String>,
    a: Option<String>,
    b: Option<String>,
}

async fn files_diff(Query(params): Query<FilesDiffParams>) -> impl IntoResponse {
    let file_a = match params.a {
        Some(ref a) if !a.is_empty() => a.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "a parameter required"})),
            );
        }
    };

    let file_b = match params.b {
        Some(ref b) if !b.is_empty() => b.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "b parameter required"})),
            );
        }
    };

    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded_base = expand_path(&base);
    let base_path = std::path::PathBuf::from(&expanded_base);

    // Resolve file paths (absolute or relative to base)
    let resolve = |f: &str| -> String {
        let p = std::path::PathBuf::from(f);
        if p.is_absolute() {
            f.to_string()
        } else {
            base_path.join(f).to_string_lossy().to_string()
        }
    };

    let path_a = resolve(&file_a);
    let path_b = resolve(&file_b);

    // Verify both files exist
    if tokio::fs::metadata(&path_a).await.is_err() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("File not found: {}", file_a)})),
        );
    }
    if tokio::fs::metadata(&path_b).await.is_err() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("File not found: {}", file_b)})),
        );
    }

    let output = tokio::process::Command::new("diff")
        .args(&["-u", &path_a, &path_b])
        .output()
        .await;

    match output {
        Ok(o) => {
            // diff returns exit code 1 when files differ (not an error)
            let diff_text = String::from_utf8_lossy(&o.stdout).to_string();
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "diff": diff_text,
                    "a": path_a,
                    "b": path_b,
                })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("diff command failed: {}", e)})),
        ),
    }
}

// ── Search API Endpoints ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SearchParams {
    path: Option<String>,
    q: Option<String>,
    regex: Option<bool>,
    case: Option<bool>,
    glob: Option<String>,
}

#[derive(Deserialize)]
struct SearchReplaceBody {
    file: String,
    line: usize,
    old: String,
    new: String,
}

#[derive(Deserialize)]
struct SearchReplaceParams {
    path: Option<String>,
}

/// GET /api/search?path=&q=&regex=bool&case=bool&glob=
/// Searches project files using ripgrep (rg) with grep -rn fallback.
async fn search_query(Query(params): Query<SearchParams>) -> impl IntoResponse {
    let query = match params.q {
        Some(ref q) if !q.is_empty() => q.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "q parameter required"})),
            );
        }
    };

    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded = expand_path(&base);
    let search_dir = match tokio::fs::canonicalize(&expanded).await {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("Invalid path: {}", e)})),
            );
        }
    };

    let use_regex = params.regex.unwrap_or(false);
    let case_sensitive = params.case.unwrap_or(false);
    let glob_pattern = params.glob.clone();
    let context_lines: usize = 3;

    // Try ripgrep first, fall back to grep
    let output = {
        let mut args: Vec<String> = vec![
            "--json".to_string(),
            "-C".to_string(),
            context_lines.to_string(),
            "--max-count".to_string(),
            "200".to_string(),
        ];

        if !case_sensitive {
            args.push("-i".to_string());
        }
        if !use_regex {
            args.push("-F".to_string()); // fixed string (literal)
        }
        if let Some(ref g) = glob_pattern {
            if !g.is_empty() {
                args.push("--glob".to_string());
                args.push(g.clone());
            }
        }
        args.push("--".to_string());
        args.push(query.clone());
        args.push(search_dir.clone());

        tokio::process::Command::new("rg")
            .args(&args)
            .output()
            .await
    };

    match output {
        Ok(o) => {
            // rg returns exit code 1 for no matches (not an error)
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();

            if !o.status.success() && o.status.code() != Some(1) {
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("rg failed: {}", stderr)})),
                );
            }

            let results = parse_rg_json_output(&stdout, &search_dir);

            (
                StatusCode::OK,
                Json(serde_json::json!({"results": results})),
            )
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                // Fallback to grep
                match search_with_grep(&query, &search_dir, use_regex, case_sensitive, &glob_pattern).await {
                    Ok(results) => (
                        StatusCode::OK,
                        Json(serde_json::json!({"results": results})),
                    ),
                    Err(err) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": err})),
                    ),
                }
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("Failed to run rg: {}", e)})),
                )
            }
        }
    }
}

/// Parse ripgrep JSON output into structured results.
fn parse_rg_json_output(stdout: &str, search_dir: &str) -> Vec<serde_json::Value> {
    let mut results: Vec<serde_json::Value> = Vec::new();
    // Track context lines keyed by (file, match_line_number)
    let mut context_before: Vec<String> = Vec::new();
    let mut last_match: Option<serde_json::Value> = None;
    let mut context_after: Vec<String> = Vec::new();
    let mut after_count: usize = 0;
    let context_size: usize = 3;

    for line in stdout.lines() {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = parsed["type"].as_str().unwrap_or("");

        match msg_type {
            "match" => {
                // Flush previous match if any
                if let Some(mut prev) = last_match.take() {
                    prev["context_after"] = serde_json::json!(context_after);
                    results.push(prev);
                }
                context_after = Vec::new();
                after_count = 0;

                let data = &parsed["data"];
                let file_path = data["path"]["text"].as_str().unwrap_or("");
                let line_number = data["line_number"].as_u64().unwrap_or(0);
                let text = data["lines"]["text"].as_str().unwrap_or("").trim_end();

                // Make path relative to search dir
                let rel_path = if file_path.starts_with(search_dir) {
                    let stripped = &file_path[search_dir.len()..];
                    if stripped.starts_with('/') { &stripped[1..] } else { stripped }
                } else {
                    file_path
                };

                last_match = Some(serde_json::json!({
                    "file": rel_path,
                    "line": line_number,
                    "text": text,
                    "context_before": context_before.clone(),
                    "context_after": [],
                }));
                context_before.clear();
            }
            "context" => {
                let data = &parsed["data"];
                let text = data["lines"]["text"].as_str().unwrap_or("").trim_end();

                if last_match.is_some() && after_count < context_size {
                    context_after.push(text.to_string());
                    after_count += 1;
                } else {
                    // This is before-context for the next match
                    context_before.push(text.to_string());
                    // Keep only last N lines of context
                    if context_before.len() > context_size {
                        context_before.remove(0);
                    }
                }
            }
            "end" | "begin" | "summary" => {
                // Flush on file boundary
                if msg_type == "end" || msg_type == "begin" {
                    if let Some(mut prev) = last_match.take() {
                        prev["context_after"] = serde_json::json!(context_after);
                        results.push(prev);
                    }
                    context_before.clear();
                    context_after = Vec::new();
                    after_count = 0;
                }
            }
            _ => {}
        }
    }

    // Flush final match
    if let Some(mut prev) = last_match.take() {
        prev["context_after"] = serde_json::json!(context_after);
        results.push(prev);
    }

    results
}

/// Fallback search using grep -rn when ripgrep is not available.
async fn search_with_grep(
    query: &str,
    search_dir: &str,
    use_regex: bool,
    case_sensitive: bool,
    _glob_pattern: &Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut args: Vec<String> = vec!["-rn".to_string()];

    if !case_sensitive {
        args.push("-i".to_string());
    }
    if !use_regex {
        args.push("-F".to_string());
    }
    // Limit output
    args.push("-m".to_string());
    args.push("200".to_string());
    args.push("--".to_string());
    args.push(query.to_string());
    args.push(search_dir.to_string());

    let output = tokio::process::Command::new("grep")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("grep failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut results: Vec<serde_json::Value> = Vec::new();

    for line in stdout.lines() {
        // Format: file:line:text
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() >= 3 {
            let file_path = parts[0];
            let line_num: u64 = parts[1].parse().unwrap_or(0);
            let text = parts[2].trim_end();

            let rel_path = if file_path.starts_with(search_dir) {
                let stripped = &file_path[search_dir.len()..];
                if stripped.starts_with('/') { &stripped[1..] } else { stripped }
            } else {
                file_path
            };

            results.push(serde_json::json!({
                "file": rel_path,
                "line": line_num,
                "text": text,
                "context_before": [],
                "context_after": [],
            }));
        }
    }

    Ok(results)
}

/// POST /api/search/replace?path=  body: {file, line, old, new}
/// Replace a specific occurrence in a file.
async fn search_replace(
    Query(params): Query<SearchReplaceParams>,
    Json(body): Json<SearchReplaceBody>,
) -> impl IntoResponse {
    let base = params.path.unwrap_or_else(|| "~".to_string());
    let expanded = expand_path(&base);
    let file_path = std::path::PathBuf::from(&expanded).join(&body.file);

    let canonical = match tokio::fs::canonicalize(&file_path).await {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("File not found: {}", e)})),
            );
        }
    };

    // Read file
    let content = match tokio::fs::read_to_string(&canonical).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Cannot read file: {}", e)})),
            );
        }
    };

    let lines: Vec<&str> = content.lines().collect();
    let line_idx = body.line.saturating_sub(1); // Convert 1-based to 0-based

    if line_idx >= lines.len() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Line {} out of range (file has {} lines)", body.line, lines.len())})),
        );
    }

    // Verify the old text exists on that line
    if !lines[line_idx].contains(&body.old) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "Old text not found on specified line — file may have changed"})),
        );
    }

    // Build new content with the replacement on the target line
    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    new_lines[line_idx] = new_lines[line_idx].replacen(&body.old, &body.new, 1);

    // Preserve trailing newline if original had one
    let mut new_content = new_lines.join("\n");
    if content.ends_with('\n') {
        new_content.push('\n');
    }

    if let Err(e) = tokio::fs::write(&canonical, &new_content).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Write failed: {}", e)})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "ok", "line": body.line})),
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

// ── Notes API ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct NotesQueryParams {
    path: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct NotesSaveBody {
    name: String,
    content: String,
}

#[derive(Deserialize)]
struct NotesDeleteBody {
    name: String,
}

/// Derive a filesystem-safe slug from a working directory path.
fn workdir_slug(path: &str) -> String {
    let expanded = expand_path(path);
    expanded
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

/// Resolve the notes directory for a given workdir path. Creates it if needed.
fn notes_dir_for(path: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let slug = workdir_slug(path);
    if slug.is_empty() {
        return Err("invalid path".to_string());
    }
    let dir = std::path::PathBuf::from(home)
        .join(".codefactory")
        .join("notes")
        .join(&slug);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create notes dir: {}", e))?;
    }
    Ok(dir)
}

/// Sanitize a note name to prevent path traversal. Returns the slug with .md extension.
fn sanitize_note_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let base = name.strip_suffix(".md").unwrap_or(name);
    if base.is_empty() {
        return Err("note name is empty".to_string());
    }
    let slug: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<&str>>()
        .join("-");
    if slug.is_empty() {
        return Err("note name is invalid".to_string());
    }
    Ok(format!("{}.md", slug))
}

/// GET /api/notes/list?path= — list notes for a workdir
async fn notes_list(Query(params): Query<NotesQueryParams>) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "path parameter required"})),
            );
        }
    };

    let dir = match notes_dir_for(&raw_path) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let mut notes: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let title = content
                .lines()
                .next()
                .unwrap_or("")
                .trim_start_matches('#')
                .trim()
                .to_string();
            let modified = path
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            notes.push(serde_json::json!({
                "name": file_name,
                "title": if title.is_empty() { file_name.trim_end_matches(".md").to_string() } else { title },
                "modified": modified,
            }));
        }
    }

    notes.sort_by(|a, b| {
        let am = a["modified"].as_u64().unwrap_or(0);
        let bm = b["modified"].as_u64().unwrap_or(0);
        bm.cmp(&am)
    });

    (
        StatusCode::OK,
        Json(serde_json::json!({"notes": notes})),
    )
}

/// GET /api/notes/read?path=&name= — read a note's content
async fn notes_read(Query(params): Query<NotesQueryParams>) -> impl IntoResponse {
    let raw_path = match params.path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "path parameter required"})),
            );
        }
    };
    let raw_name = match params.name {
        Some(n) if !n.is_empty() => n,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "name parameter required"})),
            );
        }
    };

    let dir = match notes_dir_for(&raw_path) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let safe_name = match sanitize_note_name(&raw_name) {
        Ok(n) => n,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let file_path = dir.join(&safe_name);
    match std::fs::read_to_string(&file_path) {
        Ok(content) => (
            StatusCode::OK,
            Json(serde_json::json!({"name": safe_name, "content": content})),
        ),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "note not found"})),
        ),
    }
}

/// POST /api/notes/save?path= — body: {name, content}
async fn notes_save(
    Query(params): Query<NotesQueryParams>,
    Json(body): Json<NotesSaveBody>,
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

    let dir = match notes_dir_for(&raw_path) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let safe_name = match sanitize_note_name(&body.name) {
        Ok(n) => n,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let file_path = dir.join(&safe_name);
    match std::fs::write(&file_path, &body.content) {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "ok", "name": safe_name})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("failed to write note: {}", e)})),
        ),
    }
}

/// POST /api/notes/delete?path= — body: {name}
async fn notes_delete(
    Query(params): Query<NotesQueryParams>,
    Json(body): Json<NotesDeleteBody>,
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

    let dir = match notes_dir_for(&raw_path) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let safe_name = match sanitize_note_name(&body.name) {
        Ok(n) => n,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let file_path = dir.join(&safe_name);
    if !file_path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "note not found"})),
        );
    }

    match std::fs::remove_file(&file_path) {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "ok"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("failed to delete note: {}", e)})),
        ),
    }
}

// ── Process Manager ──────────────────────────────────────────────────

#[derive(Serialize)]
struct ProcessEntry {
    pid: u32,
    user: String,
    cpu: f32,
    mem: f32,
    command: String,
    name: String,
}

/// GET /api/processes — list running processes with CPU/MEM info.
async fn processes_list() -> impl IntoResponse {
    let output = tokio::process::Command::new("ps")
        .args(["-eo", "pid,user,pcpu,pmem,args"])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let mut processes = Vec::new();

            for line in stdout.lines().skip(1) {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Parse: PID USER %CPU %MEM COMMAND...
                let parts: Vec<&str> = line.splitn(5, char::is_whitespace).collect();
                // Filter empty parts from extra whitespace
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() < 5 {
                    continue;
                }
                let pid = match parts[0].parse::<u32>() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let user = parts[1].to_string();
                let cpu = parts[2].parse::<f32>().unwrap_or(0.0);
                let mem = parts[3].parse::<f32>().unwrap_or(0.0);
                let command = parts[4..].join(" ");
                // Extract short name from command (first path component's basename)
                let name = command
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .to_string();

                processes.push(ProcessEntry {
                    pid,
                    user,
                    cpu,
                    mem,
                    command,
                    name,
                });
            }

            (
                StatusCode::OK,
                Json(serde_json::json!({"processes": processes})),
            )
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("ps failed: {}", stderr)})),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("failed to run ps: {}", e)})),
        ),
    }
}

#[derive(Deserialize)]
struct KillBody {
    pid: u32,
    signal: Option<String>,
}

/// POST /api/processes/kill — send signal to a process.
async fn processes_kill(Json(body): Json<KillBody>) -> impl IntoResponse {
    let sig = match body.signal.as_deref() {
        Some("KILL") | Some("9") => "KILL",
        _ => "TERM",
    };

    // Safety: refuse to kill PID 1 or our own process
    let my_pid = std::process::id();
    if body.pid == 1 || body.pid == my_pid {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "refusing to kill protected process"})),
        );
    }

    let output = tokio::process::Command::new("kill")
        .args([&format!("-{}", sig), &body.pid.to_string()])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "ok", "pid": body.pid, "signal": sig})),
        ),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("kill failed: {}", stderr.trim())})),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("failed to run kill: {}", e)})),
        ),
    }
}

// ── Ports ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct PortEntry {
    port: u16,
    protocol: String,
    pid: Option<u32>,
    process: Option<String>,
    state: String,
}

/// GET /api/ports — list listening ports with process info.
/// Tries `ss -tlnp` first, falls back to `netstat -tlnp`, then port-scan fallback for Termux.
async fn ports_list() -> impl IntoResponse {
    // Try ss first
    let ss_result = tokio::process::Command::new("ss")
        .args(["-tlnp"])
        .output()
        .await;

    let parsed_from_tools = match ss_result {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            Some(parse_ss_output(&stdout))
        }
        _ => {
            // Fallback to netstat variants
            let netstat_result = tokio::process::Command::new("netstat")
                .args(["-tlnp"])
                .output()
                .await;
            match &netstat_result {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let entries = parse_netstat_output(&stdout);
                    if !entries.is_empty() {
                        Some(entries)
                    } else {
                        // Try without -p flag
                        let netstat_nop = tokio::process::Command::new("netstat")
                            .args(["-tln"])
                            .output()
                            .await;
                        match netstat_nop {
                            Ok(o2) => {
                                let stdout2 = String::from_utf8_lossy(&o2.stdout).to_string();
                                let entries2 = parse_netstat_output(&stdout2);
                                if !entries2.is_empty() { Some(entries2) } else { None }
                            }
                            Err(_) => None,
                        }
                    }
                }
                Err(_) => None,
            }
        }
    };

    let ports = match parsed_from_tools {
        Some(mut entries) if !entries.is_empty() => {
            entries.sort_by_key(|p| p.port);
            entries
        }
        _ => {
            // Fallback: scan common ports by trying to connect (works on Termux)
            scan_common_ports().await
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({"ports": ports})),
    )
}

fn parse_ss_output(stdout: &str) -> Vec<PortEntry> {
    let mut ports = Vec::new();
    for line in stdout.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() { continue; }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 { continue; }
        let state = parts[0].to_string();
        let local_addr = parts[3];
        let port = match extract_port(local_addr) {
            Some(p) => p,
            None => continue,
        };
        let (pid, process) = if parts.len() > 5 {
            let process_info = parts[5..].join(" ");
            extract_pid_process_ss(&process_info)
        } else {
            (None, None)
        };
        ports.push(PortEntry { port, protocol: "tcp".to_string(), pid, process, state });
    }
    ports
}

fn parse_netstat_output(stdout: &str) -> Vec<PortEntry> {
    let mut ports = Vec::new();
    for line in stdout.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() { continue; }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 { continue; }
        let proto = parts[0].to_lowercase();
        if !proto.starts_with("tcp") { continue; }
        let local_addr = parts[3];
        let state = parts[5].to_string();
        let port = match extract_port(local_addr) {
            Some(p) => p,
            None => continue,
        };
        let (pid, process) = if parts.len() > 6 {
            extract_pid_process_netstat(parts[6])
        } else {
            (None, None)
        };
        ports.push(PortEntry { port, protocol: proto, pid, process, state });
    }
    ports
}

/// Scan common ports by attempting TCP connections (Termux fallback).
async fn scan_common_ports() -> Vec<PortEntry> {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use tokio::net::TcpStream;

    let scan_ports: Vec<u16> = vec![
        22, 80, 443, 1080, 2222,
        3000, 3001, 3002, 3003, 3333,
        4000, 4200, 4321,
        5000, 5173, 5432, 5500, 5555,
        6006, 6379, 6969,
        7000, 7070, 7777,
        8000, 8001, 8008, 8080, 8081, 8082, 8088, 8443, 8787, 8888, 8899,
        9000, 9090, 9222, 9229, 9292, 9999,
        10000, 19006, 24678, 27017,
    ];

    let addr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut handles = Vec::new();

    for port in scan_ports {
        let sock = SocketAddr::new(addr, port);
        handles.push(tokio::spawn(async move {
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                TcpStream::connect(sock),
            ).await {
                Ok(Ok(_)) => Some(port),
                _ => None,
            }
        }));
    }

    let mut ports = Vec::new();
    for handle in handles {
        if let Ok(Some(port)) = handle.await {
            ports.push(PortEntry {
                port,
                protocol: "tcp".to_string(),
                pid: None,
                process: None,
                state: "LISTEN".to_string(),
            });
        }
    }
    ports.sort_by_key(|p| p.port);
    ports
}

/// Extract port number from address like "0.0.0.0:3001", "[::]:80", "*:443", ":::8080"
fn extract_port(addr: &str) -> Option<u16> {
    // Handle IPv6 bracket notation [::]:port
    if let Some(bracket_pos) = addr.rfind("]:") {
        return addr[bracket_pos + 2..].parse().ok();
    }
    // Handle :::port (IPv6 short form from netstat)
    if addr.starts_with(":::") {
        return addr[3..].parse().ok();
    }
    // Handle addr:port (last colon)
    if let Some(colon_pos) = addr.rfind(':') {
        return addr[colon_pos + 1..].parse().ok();
    }
    None
}

/// Parse ss process field like `users:(("node",pid=12345,fd=22))`
fn extract_pid_process_ss(s: &str) -> (Option<u32>, Option<String>) {
    // Look for pid=NNNN
    let pid = s
        .find("pid=")
        .and_then(|i| {
            let rest = &s[i + 4..];
            let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            rest[..end].parse::<u32>().ok()
        });

    // Look for process name in (("name",...))
    let process = s
        .find("((\"")
        .and_then(|i| {
            let rest = &s[i + 3..];
            rest.find('"').map(|end| rest[..end].to_string())
        });

    (pid, process)
}

/// Parse netstat PID/program field like "12345/node" or "-"
fn extract_pid_process_netstat(s: &str) -> (Option<u32>, Option<String>) {
    if s == "-" || s == "-/" {
        return (None, None);
    }
    let parts: Vec<&str> = s.splitn(2, '/').collect();
    let pid = parts.first().and_then(|p| p.parse::<u32>().ok());
    let process = parts.get(1).map(|p| p.to_string());
    (pid, process)
}

// ── Config Editor API ──────────────────────────────────────────────

#[derive(Deserialize)]
struct ConfigListParams {
    path: Option<String>,
}

#[derive(Deserialize)]
struct ConfigReadParams {
    file: Option<String>,
}

#[derive(Deserialize)]
struct ConfigWriteParams {
    file: Option<String>,
}

#[derive(Deserialize)]
struct ConfigWriteBody {
    content: String,
}

/// Build the list of known config files for a given project path.
fn known_config_files(project_path: &str) -> Vec<(String, String, String)> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
    let expanded = expand_path(project_path);
    vec![
        ("profiles.json".to_string(), format!("{}/.config/codefactory/profiles.json", home), "json".to_string()),
        ("CLAUDE.md".to_string(), format!("{}/CLAUDE.md", expanded), "markdown".to_string()),
        ("backend/CLAUDE.md".to_string(), format!("{}/backend/CLAUDE.md", expanded), "markdown".to_string()),
        ("frontend/CLAUDE.md".to_string(), format!("{}/frontend/CLAUDE.md", expanded), "markdown".to_string()),
        ("claude settings".to_string(), format!("{}/.claude/settings.json", home), "json".to_string()),
        (".claude/settings.json".to_string(), format!("{}/.claude/settings.json", expanded), "json".to_string()),
        (".env".to_string(), format!("{}/.env", expanded), "env".to_string()),
        ("package.json".to_string(), format!("{}/package.json", expanded), "json".to_string()),
        ("Cargo.toml".to_string(), format!("{}/Cargo.toml", expanded), "toml".to_string()),
        (".gitignore".to_string(), format!("{}/.gitignore", expanded), "gitignore".to_string()),
    ]
}

/// Collect all absolute paths that config/list would return (used for write validation).
fn allowed_config_paths(project_path: &str) -> Vec<String> {
    known_config_files(project_path)
        .into_iter()
        .map(|(_, abs, _)| {
            // Canonicalize if it exists, otherwise keep as-is
            std::fs::canonicalize(&abs)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(abs)
        })
        .collect()
}

/// GET /api/config/list?path= — returns known config file paths and their existence status.
async fn config_list(Query(params): Query<ConfigListParams>) -> impl IntoResponse {
    let project_path = params.path.unwrap_or_else(|| ".".to_string());
    let files = known_config_files(&project_path);

    let mut results: Vec<serde_json::Value> = Vec::new();
    for (label, abs_path, syntax) in files {
        let exists = std::path::Path::new(&abs_path).exists();
        let size = if exists {
            std::fs::metadata(&abs_path).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };
        results.push(serde_json::json!({
            "label": label,
            "path": abs_path,
            "syntax": syntax,
            "exists": exists,
            "size": size,
        }));
    }

    (StatusCode::OK, Json(serde_json::json!({"files": results})))
}

/// GET /api/config/read?file= — read a config file by absolute path.
async fn config_read(Query(params): Query<ConfigReadParams>) -> impl IntoResponse {
    let file_path = match params.file {
        Some(ref f) if !f.is_empty() => f.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "file parameter required"})),
            );
        }
    };

    let expanded = expand_path(&file_path);
    let path = std::path::Path::new(&expanded);

    if !path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "File not found"})),
        );
    }

    match tokio::fs::read_to_string(&expanded).await {
        Ok(content) => (
            StatusCode::OK,
            Json(serde_json::json!({"content": content, "path": expanded})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to read file: {}", e)})),
        ),
    }
}

/// POST /api/config/write?file= — write config file (body: {content}).
/// Only allows writing to files that are in the known config list.
async fn config_write(
    Query(params): Query<ConfigWriteParams>,
    Json(body): Json<ConfigWriteBody>,
) -> impl IntoResponse {
    let file_path = match params.file {
        Some(ref f) if !f.is_empty() => f.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "file parameter required"})),
            );
        }
    };

    let expanded = expand_path(&file_path);

    // Security: check that this file is in the known config files list.
    // We check against all possible project paths by using the file's own parent directories.
    // Also try current directory as project path.
    let canonical_target = std::fs::canonicalize(&expanded)
        .unwrap_or_else(|_| std::path::PathBuf::from(&expanded));
    let canonical_str = canonical_target.to_string_lossy().to_string();

    // Check against common project paths: ".", cwd, and the parent of the file itself
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    let mut allowed = false;
    for project_path in &[cwd.as_str(), "."] {
        let valid_paths = allowed_config_paths(project_path);
        if valid_paths.iter().any(|p| p == &canonical_str || p == &expanded) {
            allowed = true;
            break;
        }
    }

    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Writing to this file is not allowed. Only known config files can be modified."})),
        );
    }

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&expanded).parent() {
        if !parent.exists() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("Failed to create directory: {}", e)})),
                );
            }
        }
    }

    match tokio::fs::write(&expanded, &body.content).await {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true, "path": expanded})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write file: {}", e)})),
        ),
    }
}

/// Sensitive env var prefixes/names to filter out.
fn is_sensitive_env(key: &str) -> bool {
    let upper = key.to_uppercase();
    let sensitive_patterns = [
        "API_KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL",
        "PRIVATE_KEY", "AUTH", "AWS_ACCESS", "AWS_SECRET",
    ];
    for pat in &sensitive_patterns {
        if upper.contains(pat) {
            return true;
        }
    }
    false
}

/// GET /api/config/env — returns filtered environment variables.
async fn config_env() -> impl IntoResponse {
    let mut vars: Vec<serde_json::Value> = std::env::vars()
        .filter(|(k, _)| !is_sensitive_env(k))
        .map(|(k, v)| serde_json::json!({"key": k, "value": v}))
        .collect();

    vars.sort_by(|a, b| {
        let ak = a["key"].as_str().unwrap_or("");
        let bk = b["key"].as_str().unwrap_or("");
        ak.cmp(bk)
    });

    (StatusCode::OK, Json(serde_json::json!({"vars": vars, "count": vars.len()})))
}

/// Wait for Ctrl+C to trigger graceful shutdown.
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C handler");
    info!("Shutdown signal received, stopping server...");
}
