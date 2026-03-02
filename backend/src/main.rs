mod config;
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
        .route("/api/pages/{*name}", get(get_page))
        .route("/api/git/graph", get(git_graph))
        .route("/api/git/commit/{hash}", get(git_commit_details))
        .route("/api/git/diff", get(git_diff))
        .route("/api/beads/issues", get(beads_issues))
        // Termux API endpoints
        .route("/api/termux/battery", get(termux_battery))
        .route("/api/termux/wifi", get(termux_wifi))
        .route("/api/termux/volume", get(termux_volume))
        .route("/api/termux/brightness", post(termux_brightness))
        .route("/api/termux/torch", post(termux_torch))
        .route("/api/termux/tts", post(termux_tts))
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
        let pages_dir = config::expand_tilde("~/.config/codefactory/pages");
        std::path::PathBuf::from(&pages_dir).join(&sanitized)
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
