use std::collections::HashMap;
use std::io::Write;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use arc_swap::ArcSwap;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::term_state::TermState;

/// A single terminal session representing one floor's PTY + tmux pairing.
///
/// The session persists across WebSocket reconnections.  Only the output
/// subscriber (mpsc sender) is swapped when a new WebSocket connects.
struct TerminalSession {
    tmux_session: String,
    #[allow(dead_code)]
    pty_master: Box<dyn MasterPty + Send>,
    /// Writer has its own lock so input writes don't contend with
    /// spawn/resize/subscribe operations on the sessions map.
    pty_writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Channel for sending input data to the dedicated writer thread.
    /// Avoids per-message `spawn_blocking` overhead — a single persistent
    /// thread drains this channel and writes to the PTY.
    input_tx: std::sync::mpsc::Sender<Vec<u8>>,
    /// Current output subscriber.  Set to Some(tx) when a WebSocket is
    /// connected, None when disconnected.  The persistent reader task
    /// checks this on every read and discards data when None.
    /// Uses ArcSwap for lock-free reads in the hot reader loop.
    output_sink: Arc<ArcSwap<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
    /// Set to false when the persistent reader task exits (PTY EOF/error).
    reader_alive: Arc<AtomicBool>,
    /// Server-side terminal emulator state.  The PTY reader thread feeds
    /// bytes into this via `process_bytes()`; a future wgpu renderer will
    /// read the cell grid.  Wrapped in `Arc<Mutex<_>>` so the reader
    /// thread (writer) and renderer thread (reader) can share it.
    term_state: Arc<Mutex<TermState>>,
    cols: u16,
    rows: u16,
    #[allow(dead_code)]
    created_at: Instant,
}

/// Manages all active terminal sessions keyed by floor ID.
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalManager {
    /// Create a new empty TerminalManager.
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a new terminal session for the given floor.
    ///
    /// Creates a detached tmux session (or reattaches to an existing one),
    /// then opens a PTY that attaches to that tmux session.  A persistent
    /// reader task is started that outlives individual WebSocket connections.
    ///
    /// Returns `Ok(true)` if a new tmux session was created, `Ok(false)` if
    /// reusing an existing session (either our own or an orphaned tmux one).
    pub fn spawn_session(&self, floor_id: &str, cols: u16, rows: u16, cwd: Option<&str>) -> Result<bool> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        // If we already have a live PTY session, reuse it — no re-attach needed.
        if let Some(session) = sessions.get(floor_id) {
            if session.reader_alive.load(Ordering::SeqCst) {
                // Verify the tmux session still exists.
                let tmux_ok = Command::new("tmux")
                    .args(["has-session", "-t", &session.tmux_session])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);

                if tmux_ok {
                    info!(floor_id = %floor_id, "Reusing existing PTY session (no re-attach)");
                    return Ok(false);
                }
            }
            // Stale session — remove it so we can recreate below.
            info!(floor_id = %floor_id, "Removing stale session");
            sessions.remove(floor_id);
        }

        let tmux_session_name = format!("codefactory-floor-{floor_id}");
        info!(floor_id = %floor_id, tmux = %tmux_session_name, "Spawning terminal session");

        // Check if a tmux session with this name already exists.
        let tmux_exists = Command::new("tmux")
            .args(["has-session", "-t", &tmux_session_name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if tmux_exists {
            info!(
                floor_id = %floor_id,
                tmux = %tmux_session_name,
                "Reattaching to existing tmux session"
            );
        } else {
            // Create a new detached tmux session.
            info!(
                floor_id = %floor_id,
                tmux = %tmux_session_name,
                cols = cols,
                rows = rows,
                "Creating new detached tmux session"
            );
            // Resolve working directory (expand ~ to $HOME)
            let resolved_cwd = cwd.map(|c| crate::config::expand_tilde(c));

            // Remove Claude Code env vars from tmux global environment
            // so shells inside tmux sessions can launch claude independently.
            let _ = Command::new("tmux")
                .args(["set-environment", "-gu", "CLAUDECODE"])
                .output();
            let _ = Command::new("tmux")
                .args(["set-environment", "-gu", "CLAUDE_CODE_TMPDIR"])
                .output();
            let _ = Command::new("tmux")
                .args(["set-environment", "-gu", "CLAUDE_CODE_ENTRYPOINT"])
                .output();

            let mut tmux_args = vec![
                "new-session".to_string(),
                "-d".to_string(),
                "-s".to_string(),
                tmux_session_name.clone(),
                "-x".to_string(),
                cols.to_string(),
                "-y".to_string(),
                rows.to_string(),
                // Pass env vars into the tmux session so spawned shells inherit them.
                "-e".to_string(), "COLORFGBG=15;0".to_string(),
                "-e".to_string(), "COLORTERM=truecolor".to_string(),
                "-e".to_string(), "NCURSES_NO_UTF8_ACS=1".to_string(),
                "-e".to_string(), "FORCE_COLOR=1".to_string(),
            ];

            if let Some(ref dir) = resolved_cwd {
                tmux_args.push("-c".to_string());
                tmux_args.push(dir.clone());
            }

            let output = Command::new("tmux")
                .args(&tmux_args)
                .env_remove("CLAUDECODE")
                .output()
                .context("Failed to run tmux new-session")?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!(floor_id = %floor_id, stderr = %stderr, "tmux new-session failed");
                return Err(anyhow!("tmux new-session failed: {stderr}"));
            }

            // Disable tmux status bar — xterm.js provides its own chrome,
            // and the status bar consumes a row that throws off sizing.
            let _ = Command::new("tmux")
                .args(["set-option", "-t", &tmux_session_name, "status", "off"])
                .output();

            // Source optional user overrides from ~/.tmux-codefactory.conf.
            let conf_path = crate::config::expand_tilde("~/.tmux-codefactory.conf");
            let source_output = Command::new("tmux")
                .args(["source-file", &conf_path])
                .output();

            match source_output {
                Ok(o) if !o.status.success() => {
                    debug!(
                        floor_id = %floor_id,
                        "~/.tmux-codefactory.conf not found (non-fatal)"
                    );
                }
                Err(e) => {
                    debug!(
                        floor_id = %floor_id,
                        error = %e,
                        "Failed to run tmux source-file (non-fatal)"
                    );
                }
                _ => {}
            }
        }

        // Detach any stale clients before opening a new PTY.
        if tmux_exists {
            let _ = Command::new("tmux")
                .args(["detach-client", "-s", &tmux_session_name])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(50));

            // Enter copy-mode on the pane BEFORE attaching.  During
            // `tmux attach-session`, tmux injects phantom bytes (0x0A,
            // 0x04, etc.) into the pane's stdin.  In copy-mode these are
            // harmlessly interpreted as scroll commands instead of reaching
            // the running application (claude, codex, shell, TUI).
            let _ = Command::new("tmux")
                .args(["copy-mode", "-t", &tmux_session_name])
                .output();
        }

        // Open a PTY and attach to the tmux session.
        info!(floor_id = %floor_id, "Opening PTY for tmux attach");
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to open PTY")?;

        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["attach-session", "-t", &tmux_session_name]);

        // Configure environment for rich terminal support.
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("FORCE_COLOR", "1");
        // Force UTF-8 box drawing chars (prevents ACS misrender in xterm.js).
        cmd.env("NCURSES_NO_UTF8_ACS", "1");
        // Tell lipgloss/charm apps the terminal has a dark background.
        cmd.env("COLORFGBG", "15;0");

        // Remove parent TMUX env var to prevent nested tmux errors.
        cmd.env_remove("TMUX");
        // Remove CLAUDECODE env var so Claude Code can launch in terminal floors.
        cmd.env_remove("CLAUDECODE");

        let _child = pair
            .slave
            .spawn_command(cmd)
            .context("Failed to spawn tmux attach in PTY")?;

        let reader = pair
            .master
            .try_clone_reader()
            .context("Failed to clone PTY reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("Failed to take PTY writer")?;

        let output_sink: Arc<ArcSwap<Option<mpsc::UnboundedSender<Vec<u8>>>>> =
            Arc::new(ArcSwap::from_pointee(None));
        let reader_alive = Arc::new(AtomicBool::new(true));

        // Create server-side terminal state for this session.
        let term_state = Arc::new(Mutex::new(TermState::new(cols, rows, None)));

        // Start persistent reader task.  This task runs for the lifetime of
        // the PTY (not the WebSocket connection).  It reads from the PTY and
        // forwards to whatever output sink is currently subscribed.
        // It also feeds every byte through the server-side terminal parser
        // so the cell grid stays up to date for the wgpu renderer.
        let sink_clone = output_sink.clone();
        let alive_clone = reader_alive.clone();
        let term_state_clone = Arc::clone(&term_state);
        let reader_floor_id = floor_id.to_string();
        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => {
                        info!(floor_id = %reader_floor_id, "PTY reader EOF");
                        alive_clone.store(false, Ordering::SeqCst);
                        // Signal subscriber that session exited (empty vec = EOF).
                        let guard = sink_clone.load();
                        if let Some(ref tx) = **guard {
                            let _ = tx.send(Vec::new());
                        }
                        break;
                    }
                    Ok(n) => {
                        let bytes = &buf[..n];

                        // Feed bytes to server-side terminal parser.
                        if let Ok(mut ts) = term_state_clone.lock() {
                            ts.process_bytes(bytes);
                        }

                        // Forward raw bytes to WebSocket subscriber (if any).
                        let guard = sink_clone.load();
                        if let Some(ref tx) = **guard {
                            // Ignore send errors — subscriber disconnected.
                            let _ = tx.send(bytes.to_vec());
                        }
                    }
                    Err(e) => {
                        error!(floor_id = %reader_floor_id, error = %e, "PTY read error");
                        alive_clone.store(false, Ordering::SeqCst);
                        let guard = sink_clone.load();
                        if let Some(ref tx) = **guard {
                            let _ = tx.send(Vec::new());
                        }
                        break;
                    }
                }
            }
        });

        // Dedicated writer thread: drains input channel and writes to PTY.
        // Eliminates per-message `spawn_blocking` overhead in the WS handler.
        let pty_writer = Arc::new(Mutex::new(writer));
        let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let writer_clone = Arc::clone(&pty_writer);
        let writer_floor_id = floor_id.to_string();
        std::thread::Builder::new()
            .name(format!("pty-writer-{floor_id}"))
            .spawn(move || {
                for data in input_rx {
                    match writer_clone.lock() {
                        Ok(mut w) => {
                            if let Err(e) = w.write_all(&data) {
                                warn!(floor_id = %writer_floor_id, error = %e, "PTY write error");
                                break;
                            }
                        }
                        Err(e) => {
                            error!(floor_id = %writer_floor_id, error = %e, "Writer lock poisoned");
                            break;
                        }
                    }
                }
            })
            .expect("Failed to spawn PTY writer thread");

        let session = TerminalSession {
            tmux_session: tmux_session_name.clone(),
            pty_master: pair.master,
            pty_writer,
            input_tx,
            output_sink,
            reader_alive,
            term_state,
            cols,
            rows,
            created_at: Instant::now(),
        };

        sessions.insert(floor_id.to_string(), session);

        // Exit copy-mode now that the attach has settled and phantom bytes
        // have been harmlessly absorbed by copy-mode's key handler.
        if tmux_exists {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = Command::new("tmux")
                .args(["send-keys", "-t", &tmux_session_name, "-X", "cancel"])
                .output();
        }

        info!(
            floor_id = %floor_id,
            tmux = %tmux_session_name,
            reattach = tmux_exists,
            "Terminal session spawned successfully"
        );

        Ok(!tmux_exists)
    }

    /// Subscribe to the PTY output for a given floor.
    ///
    /// Returns an mpsc receiver that yields raw byte chunks from the PTY.
    /// An empty Vec signals EOF (session exited).
    /// Replaces any previous subscriber (only one WebSocket at a time).
    pub fn subscribe_output(&self, floor_id: &str) -> Result<mpsc::UnboundedReceiver<Vec<u8>>> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get_mut(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;

        let (tx, rx) = mpsc::unbounded_channel();
        // Replace any previous subscriber (lock-free swap).
        session.output_sink.store(Arc::new(Some(tx)));

        // Force tmux to redraw by doing a tiny resize bump on rows.
        // The new subscriber has a fresh xterm.js instance with an empty
        // screen, but the PTY client never disconnected so tmux doesn't
        // know it needs to redraw.  Use rows (not cols) because column
        // changes can cause line-wrapping corruption if content reflows.
        let cols = session.cols;
        let rows = session.rows;
        if rows > 1 {
            let _ = session.pty_master.resize(PtySize {
                rows: rows - 1,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            let _ = session.pty_master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }

        Ok(rx)
    }

    /// Get the writer Arc for a given floor (for caching in the WS handler).
    ///
    /// Briefly grabs the sessions map lock to clone the Arc, then releases it.
    pub fn get_writer(&self, floor_id: &str) -> Result<Arc<Mutex<Box<dyn Write + Send>>>> {
        let sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;
        Ok(Arc::clone(&session.pty_writer))
    }

    /// Write input data to the PTY for a given floor.
    ///
    /// Grabs only the per-session writer lock (not the sessions map lock)
    /// so input writes don't contend with spawn/resize/subscribe operations.
    pub fn write_input(&self, floor_id: &str, data: &[u8]) -> Result<()> {
        let writer = self.get_writer(floor_id)?;
        let mut writer = writer.lock().map_err(|e| anyhow!("Writer lock poisoned: {e}"))?;
        writer.write_all(data).context("Failed to write to PTY")?;

        Ok(())
    }

    /// Write input data using a cached writer Arc (avoids sessions map lookup).
    pub fn write_input_with_writer(writer: &Arc<Mutex<Box<dyn Write + Send>>>, data: &[u8]) -> Result<()> {
        let mut writer = writer.lock().map_err(|e| anyhow!("Writer lock poisoned: {e}"))?;
        writer.write_all(data).context("Failed to write to PTY")?;
        Ok(())
    }

    /// Get the server-side terminal state for a given floor.
    ///
    /// Returns an `Arc<Mutex<TermState>>` that the wgpu renderer can lock
    /// to read the cell grid.  The PTY reader thread writes to this same
    /// TermState, so callers should hold the lock briefly.
    pub fn get_term_state(&self, floor_id: &str) -> Result<Arc<Mutex<TermState>>> {
        let sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;
        Ok(Arc::clone(&session.term_state))
    }

    /// Get the input channel sender for a given floor (for zero-overhead writes).
    ///
    /// The returned sender feeds a dedicated writer thread, avoiding
    /// per-message `spawn_blocking` in the WebSocket handler.
    pub fn get_input_sender(&self, floor_id: &str) -> Result<std::sync::mpsc::Sender<Vec<u8>>> {
        let sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;
        Ok(session.input_tx.clone())
    }

    /// Resize the PTY for a given floor.
    ///
    /// Only the PTY is resized — tmux receives SIGWINCH and adapts automatically,
    /// accounting for its own status bar. Explicitly calling `tmux resize-window`
    /// would fight with tmux's layout and cause off-by-one row mismatches.
    pub fn resize(&self, floor_id: &str, cols: u16, rows: u16) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get_mut(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;

        session
            .pty_master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to resize PTY")?;

        // Keep the server-side terminal parser in sync with the new dimensions.
        if let Ok(mut ts) = session.term_state.lock() {
            ts.resize(cols, rows);
        }

        session.cols = cols;
        session.rows = rows;

        info!(floor_id = %floor_id, cols = cols, rows = rows, "Terminal resized");
        Ok(())
    }

    /// Disconnect the WebSocket subscriber without closing the PTY or tmux session.
    ///
    /// The persistent reader task keeps running; output is simply discarded
    /// until a new subscriber connects via `subscribe_output`.
    pub fn disconnect_session(&self, floor_id: &str) -> Result<()> {
        let sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        match sessions.get(floor_id) {
            Some(session) => {
                // Drop the output subscriber so reader discards data (lock-free swap).
                session.output_sink.store(Arc::new(None));
                info!(
                    floor_id = %floor_id,
                    tmux = %session.tmux_session,
                    "Disconnected subscriber (PTY + tmux preserved)"
                );
                Ok(())
            }
            None => {
                warn!(floor_id = %floor_id, "No session to disconnect");
                Ok(()) // Not an error — session may have been closed already.
            }
        }
    }

    /// Close a session and kill the underlying tmux session.
    pub fn close_session(&self, floor_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        match sessions.remove(floor_id) {
            Some(session) => {
                let tmux_name = &session.tmux_session;
                info!(
                    floor_id = %floor_id,
                    tmux = %tmux_name,
                    "Closing terminal session and killing tmux"
                );

                // Clear output sink (lock-free swap).
                session.output_sink.store(Arc::new(None));

                let output = Command::new("tmux")
                    .args(["kill-session", "-t", tmux_name])
                    .output();

                match output {
                    Ok(o) if !o.status.success() => {
                        let stderr = String::from_utf8_lossy(&o.stderr);
                        warn!(
                            floor_id = %floor_id,
                            stderr = %stderr,
                            "tmux kill-session failed"
                        );
                    }
                    Err(e) => {
                        error!(
                            floor_id = %floor_id,
                            error = %e,
                            "Failed to run tmux kill-session"
                        );
                    }
                    _ => {
                        info!(floor_id = %floor_id, "tmux session killed");
                    }
                }

                // Session (and PTY) dropped here.  Reader task will get an
                // error on its next read and exit.
                Ok(())
            }
            None => {
                warn!(floor_id = %floor_id, "No session to close");
                Err(anyhow!("No session found for floor {floor_id}"))
            }
        }
    }

    /// List codefactory tmux sessions (static — no &self needed).
    ///
    /// Safe to call from spawn_blocking since it has no lock dependencies.
    pub fn list_tmux_sessions() -> Result<Vec<String>> {
        let output = Command::new("tmux")
            .args(["list-sessions", "-F", "#{session_name}"])
            .output()
            .context("Failed to run tmux list-sessions")?;

        // tmux exits non-zero when there are no sessions; that's not an error for us.
        if !output.status.success() {
            debug!("No tmux sessions found (tmux list-sessions returned non-zero)");
            return Ok(Vec::new());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let prefix = "codefactory-floor-";

        let existing: Vec<String> = stdout
            .lines()
            .filter_map(|line| line.strip_prefix(prefix))
            .map(|id| id.to_string())
            .collect();

        if !existing.is_empty() {
            info!(count = existing.len(), "Found existing tmux sessions: {:?}", existing);
        }

        Ok(existing)
    }

}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}
