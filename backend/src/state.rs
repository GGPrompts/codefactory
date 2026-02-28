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
}

impl AppState {
    pub fn new(config: ProfileConfig) -> Self {
        let (status_tx, _) = broadcast::channel(64);
        Self {
            profile_config: RwLock::new(config),
            terminal_manager: TerminalManager::new(),
            status_tx,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(ProfileConfig::default())
    }
}
