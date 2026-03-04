use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
};
use base64::Engine;
use futures::{stream::StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use tokio::time::Instant;

use crate::state::AppState;

// ── Messages from client to server ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "terminal-spawn")]
    Spawn {
        cols: u16,
        rows: u16,
        command: Option<String>,
        cwd: Option<String>,
    },

    #[serde(rename = "terminal-input")]
    Input { data: String }, // base64 encoded

    #[serde(rename = "terminal-resize")]
    Resize { cols: u16, rows: u16 },

    #[serde(rename = "terminal-disconnect")]
    Disconnect,

    #[serde(rename = "terminal-close")]
    Close,
}

// ── Messages from server to client ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "terminal-output")]
    Output { data: String }, // base64 encoded

    #[serde(rename = "terminal-spawned")]
    Spawned {
        #[serde(rename = "floorId")]
        floor_id: String,
        cols: u16,
        rows: u16,
    },

    #[serde(rename = "terminal-closed")]
    Closed {
        #[serde(rename = "floorId")]
        floor_id: String,
    },

    #[serde(rename = "terminal-error")]
    Error { message: String },

    #[serde(rename = "connected")]
    Connected,

    #[serde(rename = "session-status")]
    SessionStatus {
        #[serde(rename = "floorId")]
        floor_id: String,
        status: String,
        #[serde(rename = "currentTool")]
        current_tool: String,
        #[serde(rename = "subagentCount")]
        subagent_count: u32,
    },

    #[serde(rename = "log-entry")]
    LogEntry {
        level: String,
        source: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stack: Option<String>,
        timestamp: String,
    },

    #[serde(rename = "file-changed")]
    FileChanged {
        path: String,
        change_type: String,
    },
}

// ── WebSocket upgrade handler ───────────────────────────────────────────────

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(floor_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    info!(floor_id = %floor_id, "WebSocket upgrade requested");
    ws.on_upgrade(move |socket| handle_socket(socket, floor_id, state))
}

/// Send a ServerMessage over the mpsc channel. Returns false if the channel is closed.
fn send_server_msg(tx: &mpsc::UnboundedSender<ServerMessage>, msg: ServerMessage) -> bool {
    tx.send(msg).is_ok()
}

/// Handle an established WebSocket connection.
async fn handle_socket(socket: WebSocket, floor_id: String, state: Arc<AppState>) {
    info!(floor_id = %floor_id, "WebSocket connection established");

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Channel for sending messages to the WebSocket (used by both PTY reader and main loop)
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Subscribe to session status broadcasts — fed directly into the forwarder
    // via biased select! so PTY output always takes priority.
    let mut status_rx = state.status_tx.subscribe();

    // Forwarder task: reads from PTY/control mpsc channel AND status broadcast.
    // PTY output gets biased priority; status updates are rate-limited to 1/sec.
    let forwarder_handle = tokio::spawn(async move {
        let mut last_status_send = Instant::now() - std::time::Duration::from_secs(2);
        let status_interval = std::time::Duration::from_secs(1);
        // Buffer the most recent status message received between sends
        let mut pending_status: Option<ServerMessage> = None;
        // Timer that fires when the rate-limit window elapses
        let mut status_timer = std::pin::pin!(tokio::time::sleep(status_interval));
        let mut rx_closed = false;

        loop {
            // If both channels are done, exit.
            if rx_closed {
                break;
            }

            tokio::select! {
                biased;

                // Priority 1: PTY output and control messages
                msg = rx.recv() => {
                    match msg {
                        Some(m) => {
                            match serde_json::to_string(&m) {
                                Ok(json) => {
                                    if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                                Err(e) => {
                                    error!(error = %e, "Failed to serialize server message");
                                }
                            }
                        }
                        None => {
                            // mpsc sender dropped — flush any pending status then exit
                            if let Some(status_msg) = pending_status.take() {
                                if let Ok(json) = serde_json::to_string(&status_msg) {
                                    let _ = ws_sender.send(Message::Text(json.into())).await;
                                }
                            }
                            rx_closed = true;
                        }
                    }
                }

                // Priority 2: Status broadcast — buffer and rate-limit
                result = status_rx.recv() => {
                    match result {
                        Ok(msg) => {
                            let now = Instant::now();
                            if now.duration_since(last_status_send) >= status_interval {
                                // Enough time has passed — send immediately
                                match serde_json::to_string(&msg) {
                                    Ok(json) => {
                                        if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                            break;
                                        }
                                        last_status_send = now;
                                        pending_status = None;
                                    }
                                    Err(e) => {
                                        error!(error = %e, "Failed to serialize status message");
                                    }
                                }
                            } else {
                                // Rate-limited — buffer and wait for timer
                                pending_status = Some(msg);
                                let remaining = status_interval - now.duration_since(last_status_send);
                                status_timer.as_mut().reset(Instant::now() + remaining);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!(lagged = n, "Status broadcast lagged, skipping old messages");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            // Status channel closed — continue serving PTY output
                        }
                    }
                }

                // Priority 3: Flush buffered status when rate-limit window elapses
                _ = &mut status_timer, if pending_status.is_some() => {
                    if let Some(status_msg) = pending_status.take() {
                        match serde_json::to_string(&status_msg) {
                            Ok(json) => {
                                if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                                last_status_send = Instant::now();
                            }
                            Err(e) => {
                                error!(error = %e, "Failed to serialize buffered status message");
                            }
                        }
                    }
                }
            }
        }
    });

    // Send Connected message
    if !send_server_msg(&tx, ServerMessage::Connected) {
        error!(floor_id = %floor_id, "Failed to send Connected message");
        return;
    }

    // Wait for the client to send a Spawn message before creating the terminal session.
    // This allows the frontend to fetch floor config and specify command/cwd.
    let mut pty_fwd_handle: Option<tokio::task::JoinHandle<()>> = None;
    let mut session_closed = false;
    let mut spawned = false;
    let mut cached_writer: Option<Arc<Mutex<Box<dyn Write + Send>>>> = None;
    let mut cached_input_tx: Option<std::sync::mpsc::Sender<Vec<u8>>> = None;

    while let Some(result) = ws_receiver.next().await {
        match result {
            Ok(msg) => match msg {
                Message::Text(text) => {
                    match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(client_msg) => match client_msg {
                            ClientMessage::Spawn { cols, rows, command, cwd } => {
                                if spawned {
                                    warn!(floor_id = %floor_id, "Ignoring duplicate Spawn message");
                                    continue;
                                }

                                // Spawn terminal session in spawn_blocking to avoid
                                // blocking the tokio worker thread (spawn_session uses
                                // std::process::Command and thread::sleep internally).
                                let spawn_floor_id = floor_id.clone();
                                let spawn_cwd = cwd.clone();
                                let spawn_state = state.clone();
                                let is_new_session = match tokio::task::spawn_blocking(move || {
                                    spawn_state.terminal_manager.spawn_session(
                                        &spawn_floor_id,
                                        cols,
                                        rows,
                                        spawn_cwd.as_deref(),
                                    )
                                }).await {
                                    Ok(Ok(is_new)) => is_new,
                                    Ok(Err(e)) => {
                                        error!(floor_id = %floor_id, error = %e, "Failed to spawn terminal session");
                                        let _ = send_server_msg(
                                            &tx,
                                            ServerMessage::Error {
                                                message: format!("Failed to spawn terminal: {e}"),
                                            },
                                        );
                                        break;
                                    }
                                    Err(e) => {
                                        error!(floor_id = %floor_id, error = %e, "spawn_blocking panicked");
                                        break;
                                    }
                                };

                                // Send Spawned message
                                if !send_server_msg(
                                    &tx,
                                    ServerMessage::Spawned {
                                        floor_id: floor_id.clone(),
                                        cols,
                                        rows,
                                    },
                                ) {
                                    error!(floor_id = %floor_id, "Failed to send Spawned message");
                                    let _ = state.terminal_manager.disconnect_session(&floor_id);
                                    break;
                                }

                                // Subscribe to the persistent PTY reader's output.
                                let mut pty_rx = match state.terminal_manager.subscribe_output(&floor_id) {
                                    Ok(rx) => rx,
                                    Err(e) => {
                                        error!(floor_id = %floor_id, error = %e, "Failed to subscribe to PTY output");
                                        let _ = send_server_msg(
                                            &tx,
                                            ServerMessage::Error {
                                                message: format!("Failed to subscribe to output: {e}"),
                                            },
                                        );
                                        let _ = state.terminal_manager.disconnect_session(&floor_id);
                                        break;
                                    }
                                };

                                // Forwarding task: reads raw bytes from the PTY
                                // subscription channel, coalesces back-to-back
                                // chunks, and base64-encodes them for the WebSocket.
                                let pty_tx = tx.clone();
                                let pty_floor_id = floor_id.clone();
                                pty_fwd_handle = Some(tokio::spawn(async move {
                                    let mut batch = Vec::new();
                                    while let Some(data) = pty_rx.recv().await {
                                        if data.is_empty() {
                                            info!(floor_id = %pty_floor_id, "PTY reader signalled EOF");
                                            let _ = pty_tx.send(ServerMessage::Closed {
                                                floor_id: pty_floor_id.clone(),
                                            });
                                            break;
                                        }
                                        batch.extend_from_slice(&data);
                                        // Drain any additional ready chunks to coalesce
                                        // into a single WebSocket message.
                                        loop {
                                            match pty_rx.try_recv() {
                                                Ok(more) => {
                                                    if more.is_empty() {
                                                        // EOF — send what we have, then close.
                                                        if !batch.is_empty() {
                                                            let encoded = base64::engine::general_purpose::STANDARD.encode(&batch);
                                                            let _ = pty_tx.send(ServerMessage::Output { data: encoded });
                                                            batch.clear();
                                                        }
                                                        let _ = pty_tx.send(ServerMessage::Closed {
                                                            floor_id: pty_floor_id.clone(),
                                                        });
                                                        return;
                                                    }
                                                    batch.extend_from_slice(&more);
                                                }
                                                Err(_) => break,
                                            }
                                        }
                                        let encoded =
                                            base64::engine::general_purpose::STANDARD.encode(&batch);
                                        let msg = ServerMessage::Output { data: encoded };
                                        batch.clear();
                                        if pty_tx.send(msg).is_err() {
                                            info!(floor_id = %pty_floor_id, "WS output channel closed, stopping forwarder");
                                            break;
                                        }
                                    }
                                }));

                                spawned = true;

                                // Cache the writer Arc and input channel sender so
                                // input writes skip the sessions map lookup on every keystroke.
                                cached_writer = state.terminal_manager.get_writer(&floor_id).ok();
                                cached_input_tx = state.terminal_manager.get_input_sender(&floor_id).ok();

                                // Only send the initial command for truly new sessions.
                                // On reattach the process is already running — re-sending
                                // the command would inject a spurious newline/duplicate.
                                if is_new_session {
                                if let Some(ref cmd) = command {
                                    let effective_cmd = if cmd.to_lowercase().contains("claude") {
                                        format!("CLAUDE_SESSION_ID={} {}", floor_id, cmd)
                                    } else {
                                        cmd.clone()
                                    };
                                    let cmd_with_newline = format!("{}\n", effective_cmd);
                                    let cmd_floor_id = floor_id.clone();
                                    let cmd_state = state.clone();
                                    let cmd_bytes = cmd_with_newline.into_bytes();
                                    tokio::spawn(async move {
                                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                        if let Err(e) = cmd_state.terminal_manager.write_input(&cmd_floor_id, &cmd_bytes) {
                                            warn!(floor_id = %cmd_floor_id, error = %e, "Failed to write initial command to PTY");
                                        }
                                    });
                                }
                                }
                            }
                            ClientMessage::Input { data } => {
                                if !spawned {
                                    warn!(floor_id = %floor_id, "Ignoring Input before Spawn");
                                    continue;
                                }
                                match base64::engine::general_purpose::STANDARD.decode(&data) {
                                    Ok(decoded) => {
                                        // Send to dedicated writer thread via channel —
                                        // no spawn_blocking overhead per keystroke.
                                        if let Some(ref input_tx) = cached_input_tx {
                                            if let Err(e) = input_tx.send(decoded) {
                                                warn!(floor_id = %floor_id, error = %e, "PTY input channel closed");
                                            }
                                        } else if let Some(ref writer) = cached_writer {
                                            // Fallback: use cached writer directly
                                            let w = Arc::clone(writer);
                                            let input_floor_id = floor_id.clone();
                                            tokio::task::spawn_blocking(move || {
                                                if let Err(e) = crate::terminal::TerminalManager::write_input_with_writer(&w, &decoded) {
                                                    warn!(floor_id = %input_floor_id, error = %e, "Failed to write input to PTY");
                                                }
                                            });
                                        } else if let Err(e) =
                                            state.terminal_manager.write_input(&floor_id, &decoded)
                                        {
                                            warn!(floor_id = %floor_id, error = %e, "Failed to write input to PTY");
                                        }
                                    }
                                    Err(e) => {
                                        warn!(floor_id = %floor_id, error = %e, "Failed to base64 decode input");
                                    }
                                }
                            }
                            ClientMessage::Resize { cols, rows } => {
                                if !spawned {
                                    warn!(floor_id = %floor_id, "Ignoring Resize before Spawn");
                                    continue;
                                }
                                if let Err(e) =
                                    state.terminal_manager.resize(&floor_id, cols, rows)
                                {
                                    warn!(floor_id = %floor_id, error = %e, "Failed to resize terminal");
                                }
                            }
                            ClientMessage::Disconnect => {
                                info!(floor_id = %floor_id, "Client requested disconnect");
                                if spawned {
                                    let _ = state.terminal_manager.disconnect_session(&floor_id);
                                }
                                session_closed = true;
                                break;
                            }
                            ClientMessage::Close => {
                                info!(floor_id = %floor_id, "Client requested terminal close");
                                if spawned {
                                    let _ = state.terminal_manager.close_session(&floor_id);
                                    let _ = send_server_msg(
                                        &tx,
                                        ServerMessage::Closed {
                                            floor_id: floor_id.clone(),
                                        },
                                    );
                                }
                                session_closed = true;
                                break;
                            }
                        },
                        Err(e) => {
                            warn!(floor_id = %floor_id, error = %e, text = %text, "Failed to parse client message");
                        }
                    }
                }
                Message::Binary(_) => {
                    warn!(floor_id = %floor_id, "Received unexpected binary message");
                }
                Message::Close(_) => {
                    info!(floor_id = %floor_id, "Received close frame");
                    break;
                }
                // Ping/Pong handled automatically by axum
                _ => {}
            },
            Err(e) => {
                warn!(floor_id = %floor_id, error = %e, "WebSocket receive error");
                break;
            }
        }
    }

    // Cleanup: disconnect subscriber but preserve the PTY + tmux session.
    // On next page refresh the existing session will be reused (no re-attach).
    if !session_closed && spawned {
        let _ = state.terminal_manager.disconnect_session(&floor_id);
    }

    // Abort the PTY forwarding task (async, non-blocking — safe to abort).
    if let Some(handle) = pty_fwd_handle {
        handle.abort();
    }

    // Drop the sender to signal the forwarder to stop (it handles both PTY
    // output and status broadcasts in a single select! loop).
    drop(tx);
    let _ = forwarder_handle.await;

    info!(floor_id = %floor_id, "WebSocket connection closed");
}
