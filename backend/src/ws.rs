use std::sync::Arc;

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

    // Forwarder task: reads from mpsc channel and sends to WebSocket
    let forwarder_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if let Err(_) = ws_sender.send(Message::Text(json.into())).await {
                        break;
                    }
                }
                Err(e) => {
                    error!(error = %e, "Failed to serialize server message");
                }
            }
        }
    });

    // Subscribe to session status broadcasts
    let mut status_rx = state.status_tx.subscribe();
    let status_tx_ws = tx.clone();
    let status_handle = tokio::spawn(async move {
        while let Ok(msg) = status_rx.recv().await {
            if status_tx_ws.send(msg).is_err() {
                break;
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

                                // Spawn terminal session with optional cwd.
                                // Returns true if a new tmux session was created,
                                // false if reattaching to an existing one.
                                let is_new_session = match state.terminal_manager.spawn_session(
                                    &floor_id,
                                    cols,
                                    rows,
                                    cwd.as_deref(),
                                ) {
                                    Ok(is_new) => is_new,
                                    Err(e) => {
                                        error!(floor_id = %floor_id, error = %e, "Failed to spawn terminal session");
                                        let _ = send_server_msg(
                                            &tx,
                                            ServerMessage::Error {
                                                message: format!("Failed to spawn terminal: {e}"),
                                            },
                                        );
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
                                // subscription channel and base64-encodes them
                                // for the WebSocket.
                                let pty_tx = tx.clone();
                                let pty_floor_id = floor_id.clone();
                                pty_fwd_handle = Some(tokio::spawn(async move {
                                    while let Some(data) = pty_rx.recv().await {
                                        if data.is_empty() {
                                            // EOF signal from persistent reader.
                                            info!(floor_id = %pty_floor_id, "PTY reader signalled EOF");
                                            let _ = pty_tx.send(ServerMessage::Closed {
                                                floor_id: pty_floor_id.clone(),
                                            });
                                            break;
                                        }
                                        let encoded =
                                            base64::engine::general_purpose::STANDARD.encode(&data);
                                        let msg = ServerMessage::Output { data: encoded };
                                        if pty_tx.send(msg).is_err() {
                                            info!(floor_id = %pty_floor_id, "WS output channel closed, stopping forwarder");
                                            break;
                                        }
                                    }
                                }));

                                spawned = true;

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
                                        if let Err(e) =
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

    // Abort the forwarding task (async, non-blocking — safe to abort).
    if let Some(handle) = pty_fwd_handle {
        handle.abort();
    }

    // Abort the status broadcast forwarder
    status_handle.abort();

    // Drop the sender to signal the forwarder to stop
    drop(tx);
    let _ = forwarder_handle.await;

    info!(floor_id = %floor_id, "WebSocket connection closed");
}
