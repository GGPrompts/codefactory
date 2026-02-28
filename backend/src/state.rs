use crate::terminal::TerminalManager;

/// Shared application state for the CodeFactory backend.
pub struct AppState {
    /// Number of floors (terminal slots) available
    pub floor_count: usize,
    /// Manages all active terminal (PTY + tmux) sessions
    pub terminal_manager: TerminalManager,
}

impl AppState {
    pub fn new(floor_count: usize) -> Self {
        Self {
            floor_count,
            terminal_manager: TerminalManager::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(5)
    }
}
