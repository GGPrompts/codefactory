# CodeFactory

Vertical terminal complex — a web UI that manages multiple terminal profiles as "floors" in an elevator-themed interface. Floors can be **terminal** (tmux-backed) or **page** (HTML via iframe).

## Architecture

- **Rust workspace** with two crates: `backend` (axum web server) and `codefactory-tui` (ratatui settings editor)
- **Frontend**: vanilla JS/HTML/CSS served as static files by the backend (no build step)
- Config lives at `~/.config/codefactory/profiles.json`

## Quick Reference

```bash
cargo run              # start backend (default member), serves on :3001
cargo run -p codefactory-tui  # launch settings TUI
cargo check --workspace       # verify both crates compile
```

## Floor Types

- **Terminal floors** (default): tmux-backed shells with optional command, cwd, and markdown side panel
- **Page floors**: set `page` field to an HTML file path — renders in an iframe, auto-loads on startup (no power-on click needed)
- Floor type is inferred: if `page` is set → page floor, otherwise → terminal floor

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

## Conventions

- No JS framework — vanilla ES5-style IIFE modules, `var` not `let/const`
- CSS uses custom properties defined at top of `style.css` (industrial theme: `--hazard-yellow`, `--steel-*`, `--safety-green`, etc.)
- Backend uses axum + tokio; terminals spawn via tmux
- Profiles with `cwd: null` inherit `default_cwd` from config — resolution happens frontend-side
- Disabled profiles (`enabled: false`) are filtered out at render time

## Beads (Issue Tracking)

- Issues are tracked with beads (`bd`), backed by a Dolt SQL server on port 3307
- Data dir: `~/beads-dolt/` — shared across projects
- Remotes sync via `~/ObsidianVault/beads-remotes/` (file-based Dolt remotes)
- On session start: `cd ~/beads-dolt/beads_codefactory && dolt pull origin main`
- On session end (after git push): `cd ~/beads-dolt/beads_codefactory && dolt push origin main && cd ~/ObsidianVault && git add -A && git commit -m "beads sync" && git push`
- See `BEADS_SETUP.md` for full setup details

See `backend/CLAUDE.md` and `frontend/CLAUDE.md` for crate/directory-specific details.
