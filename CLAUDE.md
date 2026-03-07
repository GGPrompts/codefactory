# CodeFactory

Vertical terminal complex — a web UI that manages multiple terminal profiles as "floors" in an elevator-themed interface. Floors can be **terminal** (tmux-backed) or **page** (HTML via iframe).

## Architecture

- **Rust workspace** with two crates: `backend` (axum web server) and `codefactory-tui` (ratatui settings editor)
- **Frontend**: vanilla JS/HTML/CSS served as static files by the backend (no build step)
- **PWA**: installable via service worker + manifest (pass-through caching, install prompt only)
- Config lives at `~/.config/codefactory/profiles.json`

## Quick Reference

```bash
./start.sh             # clear log, start backend on :3001
cargo run              # start backend directly (no log reset)
cargo run -p codefactory-tui  # launch settings TUI
cargo check --workspace       # verify both crates compile
tail -f /tmp/codefactory.log  # monitor unified log stream in any terminal
```

## Floor Types

- **Terminal floors** (default): tmux-backed shells with optional command, cwd, and markdown side panel
- **Page floors**: set `page` field to an HTML file path — renders in an iframe, auto-loads on startup (no power-on click needed)
- Floor type is inferred: if `page` is set → page floor, otherwise → terminal floor
- Floor IDs are name-based slugs derived from the profile name (e.g., "Shell 1" → `shell-1`)

## Built-in Page Floors

| Page | File | Description |
|------|------|-------------|
| Git | `frontend/pages/git.html` | Stage, unstage, commit, push, pull, diff viewer |
| Git Graph | `frontend/pages/git-tree.html` | Visual commit graph using canvas |
| Diff | `frontend/pages/diff.html` | Side-by-side diff viewer (uncommitted, vs HEAD, compare two files) |
| Files | `frontend/pages/files.html` | File browser with create, rename, delete, preview |
| Search | `frontend/pages/search.html` | Full-text search across project files |
| Beads Board | `frontend/pages/beads-board.html` | Kanban board for Beads issue tracker (project dropdown) |
| Terminals | `frontend/pages/terminals.html` | Dashboard showing Claude session status, context meters, activity |
| Termux Dashboard | `frontend/pages/termux-dashboard.html` | Mobile system controls (battery, wifi, volume, brightness, torch, TTS) |
| Config | `frontend/pages/config.html` | Project config viewer |
| Logs | `frontend/pages/logs.html` | Filterable, color-coded live log viewer via WebSocket |
| Markdown | `frontend/pages/markdown.html` | Markdown file renderer |
| Notes | `frontend/pages/notes.html` | Notes editor |
| Ports | `frontend/pages/ports.html` | Port/process monitor |
| Processes | `frontend/pages/processes.html` | System process viewer |
| Snippets | `frontend/pages/snippets.html` | Code snippet manager |

## Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (required) |
| `command` | string? | Shell command (terminal floors) |
| `cwd` | string? | Working directory (null = inherit `default_cwd`) |
| `icon` | string? | Emoji icon for elevator button |
| `panel` | string? | Markdown side panel (bare name or absolute/~ path) |
| `page` | string? | HTML page path (bare name or absolute/~ path) |
| `panels` | object? | Per-edge swipe panels: `{"left": "id", "right": "id", ...}` |
| `enabled` | bool | Show/hide floor without removing it (default: true) |

## Keyboard Shortcuts

- `Alt+1` through `Alt+9` — jump to floor N
- `Alt+0` or `Alt+L` — jump to lobby
- `Escape` — exit floor edit mode

## Mobile Features

- Bottom bar with 3 swipeable panels: extra keys, chat input, elevator nav
- Extra keys: ESC, TAB, CTRL, ALT, arrows, PgUp, F1-F10, Ctrl-B, Enter (tap = one-shot, double-tap = lock)
- Chat input: text field that sends to focused terminal with delayed Enter (tuned for Claude Code)
- Swipe panels from screen edges for side panel content

## Claude Session Status

- State files at `/tmp/claude-code-state/{floorId}.json` written by TabzChrome hooks
- Backend polls these every 2s and broadcasts via WebSocket
- Frontend shows status on elevator buttons (glow effects) and floor headers (badge)
- Terminals dashboard page (`pages/terminals.html`) shows overview with context meters

## Unified Log System

Frontend JS console output and backend tracing events are merged into a single log stream:
- **Log file**: `/tmp/codefactory.log` — `tail -f` in any terminal floor to monitor live
- **Log Viewer page floor** (`pages/logs.html`): filterable, color-coded, live-streaming via WebSocket
- **Console forwarder** (`js/console-forwarder.js`): loaded first in `index.html`, intercepts `console.log/warn/error/info` and `window.onerror`, batches POSTs to `/api/logs/ingest`
- **Backend tracing layer** (`log_layer.rs`): captures tracing events and sends to same broadcast channel + log file
- Start script (`start.sh`) truncates stale log and launches the backend

## Conventions

- No JS framework — vanilla ES5-style IIFE modules, `var` not `let/const`
- CSS uses custom properties defined at top of `style.css` (industrial theme: `--hazard-yellow`, `--steel-*`, `--safety-green`, etc.)
- Backend uses axum + tokio; terminals spawn via tmux
- Profiles with `cwd: null` inherit `default_cwd` from config — resolution happens frontend-side
- Disabled profiles (`enabled: false`) are filtered out at render time

## Beads (Issue Tracking)

- At session start, call beads MCP `context(workspace_root='/home/marci/projects/codefactory')` to scope issues to this project's `cf` prefix
- Issues are tracked with ggbeads (`ggbd`) — forked beads with Supabase/Postgres backend
- All devices share one cloud Supabase database (no local server or sync needed)
- Issue prefix for this project: `cf` (e.g., `cf-xxxx`)
- CLI: `ggbd list --prefix cf`, `ggbd create`, `ggbd close cf-xxxx`
- MCP server configured globally in `~/.claude/.mcp.json`
- On Termux: uses Supabase/Postgres backend (same as all devices)
- See `BEADS_SETUP.md` for setup details

See `backend/CLAUDE.md` and `frontend/CLAUDE.md` for crate/directory-specific details.
