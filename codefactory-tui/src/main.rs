use std::io;
use std::path::PathBuf;

use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState},
    Terminal,
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Config types -- mirrors backend/src/config.rs exactly
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Profile {
    name: String,
    command: Option<String>,
    cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileConfig {
    #[serde(default = "default_cwd")]
    default_cwd: String,
    profiles: Vec<Profile>,
}

fn default_cwd() -> String {
    "~".to_string()
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            default_cwd: "~".to_string(),
            profiles: vec![
                Profile {
                    name: "Shell 1".to_string(),
                    command: None,
                    cwd: Some("~".to_string()),
                    icon: None,
                },
                Profile {
                    name: "Shell 2".to_string(),
                    command: None,
                    cwd: Some("~".to_string()),
                    icon: None,
                },
                Profile {
                    name: "Shell 3".to_string(),
                    command: None,
                    cwd: Some("~".to_string()),
                    icon: None,
                },
            ],
        }
    }
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

fn config_path() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        });
    base.join("codefactory").join("profiles.json")
}

fn load_config() -> ProfileConfig {
    let path = config_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        let config = ProfileConfig::default();
        let _ = save_config(&config);
        config
    }
}

fn save_config(config: &ProfileConfig) -> io::Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(config).expect("serialize config");

    // Atomic write: write to temp file then rename.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Auto-detection of common CLI tools
// ---------------------------------------------------------------------------

struct ToolSuggestion {
    name: &'static str,
    command: &'static str,
    icon: Option<&'static str>,
}

const WELL_KNOWN_TOOLS: &[ToolSuggestion] = &[
    ToolSuggestion { name: "lazygit",  command: "lazygit",  icon: Some("") },
    ToolSuggestion { name: "htop",     command: "htop",     icon: Some("") },
    ToolSuggestion { name: "btop",     command: "btop",     icon: Some("") },
    ToolSuggestion { name: "claude",   command: "claude",   icon: Some("") },
    ToolSuggestion { name: "codex",    command: "codex",    icon: Some("") },
    ToolSuggestion { name: "nvim",     command: "nvim",     icon: Some("") },
    ToolSuggestion { name: "vim",      command: "vim",      icon: Some("") },
    ToolSuggestion { name: "k9s",      command: "k9s",      icon: Some("") },
    ToolSuggestion { name: "lazydocker", command: "lazydocker", icon: Some("") },
    ToolSuggestion { name: "nnn",      command: "nnn",      icon: Some("") },
    ToolSuggestion { name: "yazi",     command: "yazi",     icon: Some("") },
    ToolSuggestion { name: "mc",       command: "mc",       icon: Some("") },
];

fn tool_on_path(cmd: &str) -> bool {
    which(cmd).is_some()
}

fn which(cmd: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    for dir in path_var.split(':') {
        let full = PathBuf::from(dir).join(cmd);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

fn detect_tools() -> Vec<Profile> {
    WELL_KNOWN_TOOLS
        .iter()
        .filter(|t| tool_on_path(t.command))
        .map(|t| Profile {
            name: t.name.to_string(),
            command: Some(t.command.to_string()),
            cwd: None,
            icon: t.icon.map(|s| s.to_string()),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    AddPrompt(AddField),
    EditPrompt(EditField),
    DeleteConfirm,
    GlobalCwdPrompt,
    DetectConfirm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AddField {
    Name,
    Command,
    Cwd,
    Icon,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditField {
    Name,
    Command,
    Cwd,
    Icon,
}

struct App {
    config: ProfileConfig,
    table_state: TableState,
    mode: Mode,
    input: String,
    pending_profile: Profile,
    status: String,
    should_quit: bool,
    #[allow(dead_code)]
    first_run: bool,
    detected_tools: Vec<Profile>,
}

impl App {
    fn new(config: ProfileConfig) -> Self {
        let first_run = config.profiles.is_empty()
            || (config.profiles.len() == 3
                && config.profiles.iter().all(|p| p.command.is_none()));
        let detected = if first_run { detect_tools() } else { vec![] };

        let mut table_state = TableState::default();
        if !config.profiles.is_empty() {
            table_state.select(Some(0));
        }

        let mode = if first_run && !detected.is_empty() {
            Mode::DetectConfirm
        } else {
            Mode::Normal
        };

        App {
            config,
            table_state,
            mode,
            input: String::new(),
            pending_profile: Profile {
                name: String::new(),
                command: None,
                cwd: None,
                icon: None,
            },
            status: String::new(),
            should_quit: false,
            first_run,
            detected_tools: detected,
        }
    }

    fn selected(&self) -> Option<usize> {
        self.table_state.selected()
    }

    fn save(&mut self) {
        match save_config(&self.config) {
            Ok(()) => self.status = "Saved.".to_string(),
            Err(e) => self.status = format!("Save error: {e}"),
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        // Ctrl-C always quits
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }

        match self.mode {
            Mode::Normal => self.handle_normal(key),
            Mode::AddPrompt(field) => self.handle_add_prompt(field, key),
            Mode::EditPrompt(field) => self.handle_edit_prompt(field, key),
            Mode::DeleteConfirm => self.handle_delete_confirm(key),
            Mode::GlobalCwdPrompt => self.handle_global_cwd_prompt(key),
            Mode::DetectConfirm => self.handle_detect_confirm(key),
        }
    }

    fn handle_normal(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => self.should_quit = true,

            // Navigation
            KeyCode::Char('j') | KeyCode::Down => {
                if self.config.profiles.is_empty() {
                    return;
                }
                let i = self.selected().unwrap_or(0);
                let next = if i >= self.config.profiles.len() - 1 { 0 } else { i + 1 };
                self.table_state.select(Some(next));
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.config.profiles.is_empty() {
                    return;
                }
                let i = self.selected().unwrap_or(0);
                let prev = if i == 0 { self.config.profiles.len() - 1 } else { i - 1 };
                self.table_state.select(Some(prev));
            }

            // Reorder with Shift-J / Shift-K
            KeyCode::Char('J') => {
                if let Some(i) = self.selected() {
                    if i < self.config.profiles.len() - 1 {
                        self.config.profiles.swap(i, i + 1);
                        self.table_state.select(Some(i + 1));
                        self.save();
                    }
                }
            }
            KeyCode::Char('K') => {
                if let Some(i) = self.selected() {
                    if i > 0 {
                        self.config.profiles.swap(i, i - 1);
                        self.table_state.select(Some(i - 1));
                        self.save();
                    }
                }
            }

            // Add
            KeyCode::Char('a') => {
                self.pending_profile = Profile {
                    name: String::new(),
                    command: None,
                    cwd: None,
                    icon: None,
                };
                self.input.clear();
                self.mode = Mode::AddPrompt(AddField::Name);
                self.status = "Add profile: enter name".to_string();
            }

            // Edit
            KeyCode::Char('e') => {
                if let Some(i) = self.selected() {
                    self.pending_profile = self.config.profiles[i].clone();
                    self.input = self.config.profiles[i].name.clone();
                    self.mode = Mode::EditPrompt(EditField::Name);
                    self.status = "Edit profile: name (Enter to keep, type to change)".to_string();
                }
            }

            // Delete
            KeyCode::Char('d') => {
                if self.selected().is_some() && !self.config.profiles.is_empty() {
                    self.mode = Mode::DeleteConfirm;
                    self.status = "Delete this profile? (y/n)".to_string();
                }
            }

            // Global CWD
            KeyCode::Char('g') => {
                self.input = self.config.default_cwd.clone();
                self.mode = Mode::GlobalCwdPrompt;
                self.status = "Set global default CWD:".to_string();
            }

            _ => {}
        }
    }

    // -- Add flow --

    fn handle_add_prompt(&mut self, field: AddField, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.status.clear();
            }
            KeyCode::Enter => {
                match field {
                    AddField::Name => {
                        if self.input.trim().is_empty() {
                            self.status = "Name cannot be empty.".to_string();
                            return;
                        }
                        self.pending_profile.name = self.input.trim().to_string();
                        self.input.clear();
                        self.mode = Mode::AddPrompt(AddField::Command);
                        self.status = "Command (optional, Enter to skip):".to_string();
                    }
                    AddField::Command => {
                        self.pending_profile.command = if self.input.trim().is_empty() {
                            None
                        } else {
                            Some(self.input.trim().to_string())
                        };
                        self.input.clear();
                        self.mode = Mode::AddPrompt(AddField::Cwd);
                        self.status = "Working directory (optional, Enter to skip):".to_string();
                    }
                    AddField::Cwd => {
                        self.pending_profile.cwd = if self.input.trim().is_empty() {
                            None
                        } else {
                            Some(self.input.trim().to_string())
                        };
                        self.input.clear();
                        self.mode = Mode::AddPrompt(AddField::Icon);
                        self.status = "Icon (optional, Enter to skip):".to_string();
                    }
                    AddField::Icon => {
                        self.pending_profile.icon = if self.input.trim().is_empty() {
                            None
                        } else {
                            Some(self.input.trim().to_string())
                        };
                        self.config.profiles.push(self.pending_profile.clone());
                        let idx = self.config.profiles.len() - 1;
                        self.table_state.select(Some(idx));
                        self.save();
                        self.mode = Mode::Normal;
                    }
                }
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => {
                self.input.push(c);
            }
            _ => {}
        }
    }

    // -- Edit flow --

    fn handle_edit_prompt(&mut self, field: EditField, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.status.clear();
            }
            KeyCode::Enter => {
                let idx = match self.selected() {
                    Some(i) => i,
                    None => {
                        self.mode = Mode::Normal;
                        return;
                    }
                };
                match field {
                    EditField::Name => {
                        if !self.input.trim().is_empty() {
                            self.pending_profile.name = self.input.trim().to_string();
                        }
                        self.input = self.pending_profile.command.clone().unwrap_or_default();
                        self.mode = Mode::EditPrompt(EditField::Command);
                        self.status =
                            "Edit command (Enter to keep, type to change):".to_string();
                    }
                    EditField::Command => {
                        self.pending_profile.command = if self.input.trim().is_empty() {
                            self.config.profiles[idx].command.clone()
                        } else {
                            Some(self.input.trim().to_string())
                        };
                        self.input = self.pending_profile.cwd.clone().unwrap_or_default();
                        self.mode = Mode::EditPrompt(EditField::Cwd);
                        self.status =
                            "Edit cwd (Enter to keep, type to change):".to_string();
                    }
                    EditField::Cwd => {
                        self.pending_profile.cwd = if self.input.trim().is_empty() {
                            self.config.profiles[idx].cwd.clone()
                        } else {
                            Some(self.input.trim().to_string())
                        };
                        self.input = self.pending_profile.icon.clone().unwrap_or_default();
                        self.mode = Mode::EditPrompt(EditField::Icon);
                        self.status =
                            "Edit icon (Enter to keep, type to change):".to_string();
                    }
                    EditField::Icon => {
                        self.pending_profile.icon = if self.input.trim().is_empty() {
                            self.config.profiles[idx].icon.clone()
                        } else {
                            Some(self.input.trim().to_string())
                        };
                        self.config.profiles[idx] = self.pending_profile.clone();
                        self.save();
                        self.mode = Mode::Normal;
                    }
                }
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => {
                self.input.push(c);
            }
            _ => {}
        }
    }

    // -- Delete confirm --

    fn handle_delete_confirm(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                if let Some(i) = self.selected() {
                    self.config.profiles.remove(i);
                    if self.config.profiles.is_empty() {
                        self.table_state.select(None);
                    } else if i >= self.config.profiles.len() {
                        self.table_state.select(Some(self.config.profiles.len() - 1));
                    }
                    self.save();
                }
                self.mode = Mode::Normal;
            }
            _ => {
                self.mode = Mode::Normal;
                self.status = "Delete cancelled.".to_string();
            }
        }
    }

    // -- Global CWD prompt --

    fn handle_global_cwd_prompt(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.status.clear();
            }
            KeyCode::Enter => {
                if !self.input.trim().is_empty() {
                    self.config.default_cwd = self.input.trim().to_string();
                    self.save();
                }
                self.mode = Mode::Normal;
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => {
                self.input.push(c);
            }
            _ => {}
        }
    }

    // -- First-run detection confirm --

    fn handle_detect_confirm(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                let tools = std::mem::take(&mut self.detected_tools);
                for t in tools {
                    self.config.profiles.push(t);
                }
                if !self.config.profiles.is_empty() {
                    self.table_state.select(Some(0));
                }
                self.save();
                self.mode = Mode::Normal;
                self.status = "Detected tools added.".to_string();
            }
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                self.detected_tools.clear();
                self.mode = Mode::Normal;
                self.status.clear();
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

fn ui(f: &mut ratatui::Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // title
            Constraint::Min(5),   // table
            Constraint::Length(3), // status / input
        ])
        .split(f.area());

    // -- Title bar --
    let title_text = format!(
        " CodeFactory Profile Editor   [default_cwd: {}]",
        app.config.default_cwd
    );
    let title = Paragraph::new(title_text).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" codefactory-tui "),
    );
    f.render_widget(title, chunks[0]);

    // -- Profile table --
    let header_cells = ["#", "Name", "Command", "CWD", "Icon"]
        .iter()
        .map(|h| Cell::from(*h).style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)));
    let header = Row::new(header_cells).height(1);

    let rows: Vec<Row> = app
        .config
        .profiles
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let cells = vec![
                Cell::from(format!("{}", i + 1)),
                Cell::from(p.name.as_str()),
                Cell::from(p.command.as_deref().unwrap_or("-")),
                Cell::from(p.cwd.as_deref().unwrap_or("-")),
                Cell::from(p.icon.as_deref().unwrap_or("")),
            ];
            Row::new(cells)
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(3),
            Constraint::Percentage(25),
            Constraint::Percentage(30),
            Constraint::Percentage(30),
            Constraint::Length(6),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Profiles (j/k=nav  J/K=reorder  a=add  e=edit  d=del  g=cwd  q=quit) "),
    )
    .row_highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD));

    f.render_stateful_widget(table, chunks[1], &mut app.table_state);

    // -- Status / input bar --
    let bar_content = match app.mode {
        Mode::Normal => {
            Line::from(vec![Span::styled(
                format!(" {}", app.status),
                Style::default().fg(Color::Green),
            )])
        }
        Mode::DeleteConfirm => {
            Line::from(vec![Span::styled(
                " Delete this profile? (y/n)",
                Style::default().fg(Color::Red),
            )])
        }
        Mode::DetectConfirm => {
            let names: Vec<String> = app.detected_tools.iter().map(|t| t.name.clone()).collect();
            Line::from(vec![Span::styled(
                format!(" Found tools on PATH: {}. Add them? (y/n)", names.join(", ")),
                Style::default().fg(Color::Cyan),
            )])
        }
        _ => {
            Line::from(vec![
                Span::styled(format!(" {} ", app.status), Style::default().fg(Color::Yellow)),
                Span::raw(&app.input),
                Span::styled("_", Style::default().fg(Color::Gray)),
            ])
        }
    };
    let status_bar = Paragraph::new(bar_content).block(Block::default().borders(Borders::ALL));
    f.render_widget(status_bar, chunks[2]);

    // -- Detect confirm overlay (centered popup) --
    if app.mode == Mode::DetectConfirm {
        let area = centered_rect(60, 50, f.area());
        f.render_widget(Clear, area);
        let names: Vec<String> = app
            .detected_tools
            .iter()
            .map(|t| format!("  - {} ({})", t.name, t.command.as_deref().unwrap_or("?")))
            .collect();
        let text = format!(
            "Detected {} tools on PATH:\n\n{}\n\nAdd these as profiles? (y/n)",
            app.detected_tools.len(),
            names.join("\n")
        );
        let popup = Paragraph::new(text).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" First-Run Detection ")
                .style(Style::default().bg(Color::Black)),
        );
        f.render_widget(popup, area);
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() -> io::Result<()> {
    let config = load_config();

    // Terminal setup
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(config);

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        if let Event::Key(key) = event::read()? {
            app.handle_key(key);
        }

        if app.should_quit {
            break;
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    Ok(())
}
