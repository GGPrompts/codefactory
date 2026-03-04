# CodeFactory

An industrial-themed terminal complex that manages multiple terminal sessions as "floors" in an elevator UI. Built with Rust and xterm.js, it runs as a PWA on both desktop and Android (via Termux), with live tmux-backed terminals in the browser.

**Notable**: This project uses a patched version of [portable-pty](https://crates.io/crates/portable-pty) that enables real PTY/tmux terminal sessions on Android — something `node-pty` and stock `portable-pty` can't do.

## Architecture

```
Browser (xterm.js) ←→ WebSocket ←→ Axum (Rust) ←→ PTY ←→ tmux sessions
```

- **Backend**: Rust workspace — `backend` (Axum web server) and `codefactory-tui` (Ratatui settings editor)
- **Frontend**: Vanilla JS/HTML/CSS with no build step, served as static files
- **Terminals**: tmux-backed sessions that persist across browser refreshes via persistent PTY reader threads
- **PWA**: Installable on desktop and mobile via service worker + manifest

## Getting Started

```bash
./start.sh                        # clear log, start backend on :3001
cargo run                         # start backend directly
cargo run -p codefactory-tui      # launch settings TUI
```

Config lives at `~/.config/codefactory/profiles.json`.

## Floor Types

- **Terminal floors**: tmux-backed shells with optional command, working directory, and markdown side panel
- **Page floors**: HTML pages rendered in an iframe, auto-loaded on startup

Floor type is inferred from the profile — if `page` is set it's a page floor, otherwise it's a terminal floor.

### Built-in Page Floors

| Page | Description |
|------|-------------|
| Git | Stage, unstage, commit, push, pull, diff viewer with AI commit messages |
| Git Graph | Visual commit graph rendered on canvas |
| Beads Board | Kanban board for the Beads issue tracker |
| Terminals | Dashboard with Claude session status, context meters, activity |
| Termux Dashboard | Mobile system controls (battery, wifi, volume, brightness, torch, TTS) |
| Log Viewer | Filterable, color-coded, live-streaming unified log |

## Profile Configuration

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (required) |
| `command` | string? | Shell command to run |
| `cwd` | string? | Working directory (null = inherit `default_cwd`) |
| `icon` | string? | Emoji icon for elevator button |
| `panel` | string? | Markdown side panel |
| `page` | string? | HTML page path (makes it a page floor) |
| `panels` | object? | Per-edge swipe panels: `{"left": "id", "right": "id"}` |
| `enabled` | bool | Show/hide without removing (default: true) |

## Features

### Desktop
- Elevator UI with animated doors and industrial CSS theme
- Side panels with markdown reference docs and terminal capture view
- Resizable panels with drag handles, state persisted to localStorage
- Keyboard shortcuts: `Alt+1`–`Alt+9` jump to floors, `Alt+0`/`Alt+L` for lobby
- Claude session status shown as glow effects on elevator buttons

### Mobile
- Bottom bar with swipeable panels: extra keys, chat input, floor navigation
- Extra keys row: ESC, TAB, CTRL, ALT, arrows, PgUp, F1-F10 (tap = one-shot, double-tap = lock)
- Chat input with delayed Enter, tuned for sending messages to Claude Code sessions
- Pinch-to-zoom on terminals (adjusts font size like Termux, 6–30px range)
- Full-screen terminal capture panel for easy copy/paste
- Swipe-from-edge panels for side content
- Termux API integration: battery, wifi, volume, brightness, torch, TTS

### Claude Integration
- Terminals running Claude Code get `CLAUDE_SESSION_ID` env var set automatically
- State files at `/tmp/claude-code-state/{floorId}.json` polled every 2s
- Status broadcast via WebSocket: idle, processing, awaiting input, tool use
- Terminals dashboard page shows all sessions at a glance with context meters

### Unified Logging
- Frontend `console.log/warn/error` and backend tracing events merged into `/tmp/codefactory.log`
- Console forwarder batches POSTs to `/api/logs/ingest`
- Log viewer page floor with filtering and color-coding
- Monitor live: `tail -f /tmp/codefactory.log`

## Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Rust, Axum, Tokio, portable-pty (patched), tmux |
| Frontend | Vanilla JS (ES5), xterm.js, HTML/CSS |
| Settings TUI | Ratatui, Crossterm |
| Styling | CSS custom properties (industrial theme) |
| PWA | Service worker, Web App Manifest |

## Conventions

- No JS framework — vanilla ES5-style IIFEs, `var` not `let/const`
- Industrial CSS theme via custom properties: `--hazard-yellow`, `--steel-*`, `--safety-green`, etc.
- Profiles with `cwd: null` inherit `default_cwd` from config
- Disabled profiles (`enabled: false`) filtered out at render time
