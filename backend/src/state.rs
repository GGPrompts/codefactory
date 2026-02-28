use std::sync::RwLock;

use crate::config::ProfileConfig;
use crate::terminal::TerminalManager;

/// Shared application state for the CodeFactory backend.
pub struct AppState {
    /// User profile configuration (terminal slots, commands, cwds)
    pub profile_config: RwLock<ProfileConfig>,
    /// Manages all active terminal (PTY + tmux) sessions
    pub terminal_manager: TerminalManager,
}

impl AppState {
    pub fn new(config: ProfileConfig) -> Self {
        Self {
            profile_config: RwLock::new(config),
            terminal_manager: TerminalManager::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(ProfileConfig::default())
    }
}
