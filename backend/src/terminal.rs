use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tracing::{debug, error, info, warn};

/// A single terminal session representing one floor's PTY + tmux pairing.
struct TerminalSession {
    floor_id: String,
    tmux_session: String,
    #[allow(dead_code)]
    pty_master: Box<dyn MasterPty + Send>,
    pty_reader: Option<Box<dyn Read + Send>>,
    pty_writer: Box<dyn Write + Send>,
    #[allow(dead_code)]
    cols: u16,
    #[allow(dead_code)]
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
    /// then opens a PTY that attaches to that tmux session.
    pub fn spawn_session(&self, floor_id: &str, cols: u16, rows: u16, cwd: Option<&str>) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        // Return early if session already exists for this floor.
        if sessions.contains_key(floor_id) {
            info!(floor_id = %floor_id, "Session already exists, skipping spawn");
            return Ok(());
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
            let resolved_cwd = cwd.map(|c| {
                if c.starts_with('~') {
                    if let Ok(home) = std::env::var("HOME") {
                        c.replacen('~', &home, 1)
                    } else {
                        c.to_string()
                    }
                } else {
                    c.to_string()
                }
            });

            let mut tmux_args = vec![
                "new-session".to_string(),
                "-d".to_string(),
                "-s".to_string(),
                tmux_session_name.clone(),
                "-x".to_string(),
                cols.to_string(),
                "-y".to_string(),
                rows.to_string(),
            ];

            if let Some(ref dir) = resolved_cwd {
                tmux_args.push("-c".to_string());
                tmux_args.push(dir.clone());
            }

            let output = Command::new("tmux")
                .args(&tmux_args)
                .output()
                .context("Failed to run tmux new-session")?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!(floor_id = %floor_id, stderr = %stderr, "tmux new-session failed");
                return Err(anyhow!("tmux new-session failed: {stderr}"));
            }

            // Source the codefactory tmux config.
            debug!(floor_id = %floor_id, "Sourcing .tmux-codefactory.conf");
            let source_output = Command::new("tmux")
                .args(["source-file", ".tmux-codefactory.conf"])
                .output();

            match source_output {
                Ok(o) if !o.status.success() => {
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    warn!(
                        floor_id = %floor_id,
                        stderr = %stderr,
                        "tmux source-file warning (non-fatal)"
                    );
                }
                Err(e) => {
                    warn!(
                        floor_id = %floor_id,
                        error = %e,
                        "Failed to run tmux source-file (non-fatal)"
                    );
                }
                _ => {}
            }
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

        // Remove parent TMUX env var to prevent nested tmux errors.
        cmd.env_remove("TMUX");

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

        let session = TerminalSession {
            floor_id: floor_id.to_string(),
            tmux_session: tmux_session_name.clone(),
            pty_master: pair.master,
            pty_reader: Some(reader),
            pty_writer: writer,
            cols,
            rows,
            created_at: Instant::now(),
        };

        sessions.insert(floor_id.to_string(), session);
        info!(
            floor_id = %floor_id,
            tmux = %tmux_session_name,
            "Terminal session spawned successfully"
        );

        Ok(())
    }

    /// Write input data to the PTY for a given floor.
    pub fn write_input(&self, floor_id: &str, data: &[u8]) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get_mut(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;

        session
            .pty_writer
            .write_all(data)
            .context("Failed to write to PTY")?;

        Ok(())
    }

    /// Resize the PTY and tmux window for a given floor.
    pub fn resize(&self, floor_id: &str, cols: u16, rows: u16) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get_mut(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;

        // Resize the PTY.
        session
            .pty_master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to resize PTY")?;

        // Sync tmux window size.
        let tmux_name = &session.tmux_session;
        let output = Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                tmux_name,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .output()
            .context("Failed to run tmux resize-window")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(
                floor_id = %floor_id,
                stderr = %stderr,
                "tmux resize-window failed (non-fatal)"
            );
        }

        session.cols = cols;
        session.rows = rows;

        info!(floor_id = %floor_id, cols = cols, rows = rows, "Terminal resized");
        Ok(())
    }

    /// Take the PTY reader out of the session so it can be moved to an async read task.
    ///
    /// This should only be called once per session. Subsequent calls will return an error.
    pub fn take_reader(&self, floor_id: &str) -> Result<Box<dyn Read + Send>> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;
        let session = sessions
            .get_mut(floor_id)
            .ok_or_else(|| anyhow!("No session found for floor {floor_id}"))?;

        session
            .pty_reader
            .take()
            .ok_or_else(|| anyhow!("Reader already taken for floor {floor_id}"))
    }

    /// Disconnect from a session without killing the tmux session.
    ///
    /// The PTY is dropped (detaching from tmux), but the tmux session stays alive
    /// so it can be reattached later.
    pub fn disconnect_session(&self, floor_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        match sessions.remove(floor_id) {
            Some(session) => {
                info!(
                    floor_id = %floor_id,
                    tmux = %session.tmux_session,
                    "Disconnected from terminal session (tmux session preserved)"
                );
                // Session is dropped here, which closes the PTY.
                Ok(())
            }
            None => {
                warn!(floor_id = %floor_id, "No session to disconnect");
                Err(anyhow!("No session found for floor {floor_id}"))
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

                // Session (and PTY) dropped here.
                Ok(())
            }
            None => {
                warn!(floor_id = %floor_id, "No session to close");
                Err(anyhow!("No session found for floor {floor_id}"))
            }
        }
    }

    /// List floor IDs that have tmux sessions alive but no active PTY connection.
    ///
    /// Useful for recovery on backend restart: these sessions can be reattached.
    pub fn list_orphaned_sessions(&self) -> Result<Vec<String>> {
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

        let sessions = self.sessions.lock().map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        let orphaned: Vec<String> = stdout
            .lines()
            .filter_map(|line| line.strip_prefix(prefix))
            .map(|id| id.to_string())
            .filter(|id| !sessions.contains_key(id))
            .collect();

        if !orphaned.is_empty() {
            info!(count = orphaned.len(), "Found orphaned tmux sessions: {:?}", orphaned);
        }

        Ok(orphaned)
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}
