use std::collections::VecDeque;
use std::sync::RwLock;

use tokio::sync::broadcast;

use crate::config::ProfileConfig;
use crate::terminal::TerminalManager;
use crate::ws::ServerMessage;

/// Shared application state for the CodeFactory backend.
pub struct AppState {
    /// User profile configuration (terminal slots, commands, cwds)
    pub profile_config: RwLock<ProfileConfig>,
    /// Manages all active terminal (PTY + tmux) sessions
    pub terminal_manager: TerminalManager,
    /// Broadcast channel for session status updates (sent to all WebSocket clients)
    pub status_tx: broadcast::Sender<ServerMessage>,
    /// Broadcast channel for log entries (JS console + backend tracing)
    pub log_tx: broadcast::Sender<ServerMessage>,
    /// Ring buffer of recent log entries for GET /api/logs
    pub logs: RwLock<VecDeque<ServerMessage>>,
    /// Broadcast channel for live-reload file change notifications
    pub reload_tx: broadcast::Sender<ServerMessage>,
}

impl AppState {
    pub fn new(config: ProfileConfig) -> Self {
        let (log_tx, _) = broadcast::channel(256);
        Self::new_with_log_tx(config, log_tx)
    }

    /// Create with a pre-existing log_tx (used when tracing layer needs the sender
    /// before AppState is constructed).
    pub fn new_with_log_tx(
        config: ProfileConfig,
        log_tx: broadcast::Sender<ServerMessage>,
    ) -> Self {
        let (status_tx, _) = broadcast::channel(64);
        let (reload_tx, _) = broadcast::channel(16);

        Self {
            profile_config: RwLock::new(config),
            terminal_manager: TerminalManager::new(),
            status_tx,
            log_tx,
            logs: RwLock::new(VecDeque::with_capacity(500)),
            reload_tx,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(ProfileConfig::default())
    }
}
