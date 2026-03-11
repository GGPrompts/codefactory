//! Server-side terminal state powered by alacritty_terminal.
//!
//! Wraps `alacritty_terminal::Term` with a VTE parser so that raw PTY bytes
//! can be fed in and the resulting styled cell grid is available for the
//! future wgpu renderer.  The WebSocket path continues to forward raw bytes
//! to xterm.js clients unchanged.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::Config;
use alacritty_terminal::vte::ansi;
use alacritty_terminal::Term;
use tracing::{debug, trace};

// ---------------------------------------------------------------------------
// EventProxy -- receives events emitted by the terminal emulator
// ---------------------------------------------------------------------------

/// Receives events from `alacritty_terminal::Term` (title changes, bell,
/// clipboard requests, etc.).  For now we log them; a future iteration may
/// forward PtyWrite events back to the PTY.
#[derive(Clone)]
pub struct EventProxy {
    /// Accumulated title (last Title event wins).
    title: Arc<Mutex<Option<String>>>,
}

impl EventProxy {
    pub fn new() -> Self {
        Self {
            title: Arc::new(Mutex::new(None)),
        }
    }

    /// Return the most recently set window title, if any.
    pub fn title(&self) -> Option<String> {
        self.title.lock().ok().and_then(|t| t.clone())
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(ref title) => {
                debug!(title = %title, "Terminal title changed");
                if let Ok(mut t) = self.title.lock() {
                    *t = Some(title.clone());
                }
            }
            Event::ResetTitle => {
                debug!("Terminal title reset");
                if let Ok(mut t) = self.title.lock() {
                    *t = None;
                }
            }
            Event::Bell => {
                trace!("Terminal bell");
            }
            Event::PtyWrite(ref text) => {
                // The terminal wants to write back to the PTY (e.g. DA response).
                // TODO: wire this to the PTY writer when integrating with terminal.rs.
                debug!(len = text.len(), "Terminal requested PTY write (not wired yet)");
            }
            Event::ColorRequest(index, _) => {
                trace!(index = index, "Color request (ignored)");
            }
            Event::TextAreaSizeRequest(_) => {
                trace!("Text area size request (ignored)");
            }
            Event::ClipboardStore(_, _) => {
                trace!("Clipboard store request (ignored)");
            }
            Event::ClipboardLoad(_, _) => {
                trace!("Clipboard load request (ignored)");
            }
            Event::Wakeup | Event::MouseCursorDirty | Event::CursorBlinkingChange => {
                // High-frequency events -- suppress logging.
            }
            Event::Exit | Event::ChildExit(_) => {
                debug!(?event, "Terminal exit event");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// TermSize -- implements Dimensions for Term::new / Term::resize
// ---------------------------------------------------------------------------

/// Minimal terminal size descriptor implementing `Dimensions`.
#[derive(Debug, Clone, Copy)]
pub struct TermSize {
    pub columns: usize,
    pub screen_lines: usize,
}

impl TermSize {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            columns: cols as usize,
            screen_lines: rows as usize,
        }
    }
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

// ---------------------------------------------------------------------------
// TermState -- the main wrapper
// ---------------------------------------------------------------------------

/// Server-side terminal emulator state.
///
/// Wraps `alacritty_terminal::Term` with a VTE parser to maintain a styled
/// cell grid that the wgpu renderer can consume.
///
/// Thread safety: callers are expected to wrap this in `Arc<Mutex<_>>` and
/// lock before calling any method.  The PTY reader thread calls
/// `process_bytes` while the renderer thread reads via `grid`.
pub struct TermState {
    term: Term<EventProxy>,
    parser: ansi::Processor,
    event_proxy: EventProxy,
}

impl TermState {
    /// Create a new terminal state with the given dimensions.
    ///
    /// `scrollback_lines` controls how many lines of history are kept
    /// (default 10_000 if None).
    pub fn new(cols: u16, rows: u16, scrollback_lines: Option<usize>) -> Self {
        let config = Config {
            scrolling_history: scrollback_lines.unwrap_or(10_000),
            ..Config::default()
        };

        let size = TermSize::new(cols, rows);
        let event_proxy = EventProxy::new();
        let term = Term::new(config, &size, event_proxy.clone());
        let parser = ansi::Processor::new();

        Self {
            term,
            parser,
            event_proxy,
        }
    }

    /// Feed raw PTY output bytes through the VTE parser into the terminal.
    ///
    /// After this call the cell grid reflects the updated terminal content.
    pub fn process_bytes(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// Read-only access to the current cell grid.
    pub fn grid(&self) -> &Grid<Cell> {
        self.term.grid()
    }

    /// Resize the terminal to new dimensions.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = TermSize::new(cols, rows);
        self.term.resize(size);
    }

    /// Number of scrollback history lines currently stored.
    pub fn history_size(&self) -> usize {
        self.term.grid().history_size()
    }

    /// Total lines (visible + scrollback).
    pub fn total_lines(&self) -> usize {
        self.term.grid().total_lines()
    }

    /// Number of visible screen lines.
    pub fn screen_lines(&self) -> usize {
        self.term.grid().screen_lines()
    }

    /// Number of columns.
    pub fn columns(&self) -> usize {
        self.term.grid().columns()
    }

    /// The most recently set terminal title (via OSC escape), if any.
    pub fn title(&self) -> Option<String> {
        self.event_proxy.title()
    }

    /// Access the underlying Term for advanced queries (selection, cursor, etc.).
    pub fn term(&self) -> &Term<EventProxy> {
        &self.term
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::cell::Flags;
    use alacritty_terminal::vte::ansi::NamedColor;

    /// Helper: create a small terminal and process the given string.
    fn term_with(cols: u16, rows: u16, input: &str) -> TermState {
        let mut ts = TermState::new(cols, rows, Some(100));
        ts.process_bytes(input.as_bytes());
        ts
    }

    /// Helper: read visible text from a specific row (0-indexed from top).
    fn row_text(ts: &TermState, row: usize) -> String {
        let grid = ts.grid();
        let line = Line(row as i32);
        let cols = grid.columns();
        (0..cols)
            .map(|c| grid[line][Column(c)].c)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn test_basic_text() {
        let ts = term_with(40, 5, "Hello, world!");
        assert_eq!(row_text(&ts, 0), "Hello, world!");
    }

    #[test]
    fn test_dimensions() {
        let ts = TermState::new(80, 24, None);
        assert_eq!(ts.columns(), 80);
        assert_eq!(ts.screen_lines(), 24);
    }

    #[test]
    fn test_resize() {
        let mut ts = TermState::new(80, 24, None);
        ts.resize(120, 40);
        assert_eq!(ts.columns(), 120);
        assert_eq!(ts.screen_lines(), 40);
    }

    #[test]
    fn test_newline() {
        let ts = term_with(40, 5, "line1\r\nline2");
        assert_eq!(row_text(&ts, 0), "line1");
        assert_eq!(row_text(&ts, 1), "line2");
    }

    #[test]
    fn test_cursor_movement() {
        // ESC[2;5H = move cursor to row 2, column 5 (1-indexed)
        let ts = term_with(20, 5, "\x1b[2;5HX");
        let grid = ts.grid();
        let cell = &grid[Line(1)][Column(4)];
        assert_eq!(cell.c, 'X');
    }

    #[test]
    fn test_sgr_bold() {
        // ESC[1m = bold, then text, then ESC[0m = reset
        let ts = term_with(20, 5, "\x1b[1mBOLD\x1b[0m");
        let grid = ts.grid();
        let cell = &grid[Line(0)][Column(0)];
        assert_eq!(cell.c, 'B');
        assert!(cell.flags.contains(Flags::BOLD));

        // After reset, next cell should not be bold
        // "BOLD" is 4 chars, cursor is at col 4 after writing
        // We haven't written anything at col 4, so check col 3 is still bold
        let last_bold = &grid[Line(0)][Column(3)];
        assert_eq!(last_bold.c, 'D');
        assert!(last_bold.flags.contains(Flags::BOLD));
    }

    #[test]
    fn test_sgr_colors() {
        // ESC[31m = red foreground
        let ts = term_with(20, 5, "\x1b[31mRED");
        let grid = ts.grid();
        let cell = &grid[Line(0)][Column(0)];
        assert_eq!(cell.c, 'R');
        use alacritty_terminal::vte::ansi::Color;
        assert_eq!(cell.fg, Color::Named(NamedColor::Red));
    }

    #[test]
    fn test_clear_screen() {
        // Write text, then ESC[2J = clear screen, ESC[H = home
        let mut ts = term_with(20, 5, "visible text");
        ts.process_bytes(b"\x1b[2J\x1b[H");
        // After clear, first row should be empty
        assert_eq!(row_text(&ts, 0), "");
    }

    #[test]
    fn test_line_wrapping() {
        // Write more characters than columns to trigger wrapping
        let ts = term_with(5, 3, "abcdefgh");
        assert_eq!(row_text(&ts, 0), "abcde");
        assert_eq!(row_text(&ts, 1), "fgh");
    }

    #[test]
    fn test_scrollback() {
        // Fill screen (3 lines) then write more to push into scrollback
        let ts = term_with(10, 3, "line1\r\nline2\r\nline3\r\nline4\r\nline5");
        // line1 and line2 should be in scrollback, line3-5 visible
        assert!(ts.history_size() >= 2);
    }

    #[test]
    fn test_title_osc() {
        // OSC 0 ; title BEL = set title
        let ts = term_with(40, 5, "\x1b]0;My Terminal\x07");
        assert_eq!(ts.title(), Some("My Terminal".to_string()));
    }

    #[test]
    fn test_incremental_processing() {
        // Feed bytes incrementally (simulating chunked PTY reads)
        let mut ts = TermState::new(40, 5, None);
        ts.process_bytes(b"Hel");
        ts.process_bytes(b"lo");
        assert_eq!(row_text(&ts, 0), "Hello");
    }

    #[test]
    fn test_split_escape_sequence() {
        // Split an escape sequence across two process_bytes calls
        let mut ts = TermState::new(20, 5, None);
        // ESC[31m = red foreground, split between ESC[ and 31m
        ts.process_bytes(b"\x1b[");
        ts.process_bytes(b"31mR");
        let grid = ts.grid();
        let cell = &grid[Line(0)][Column(0)];
        assert_eq!(cell.c, 'R');
        use alacritty_terminal::vte::ansi::Color;
        assert_eq!(cell.fg, Color::Named(NamedColor::Red));
    }
}
