# CodeFactory

Vertical terminal complex — a web UI that manages multiple terminal profiles as "floors" in an elevator-themed interface.

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

## Conventions

- No JS framework — vanilla ES5-style IIFE modules, `var` not `let/const`
- CSS uses custom properties defined at top of `style.css` (industrial theme: `--hazard-yellow`, `--steel-*`, `--safety-green`, etc.)
- Backend uses axum + tokio; terminals spawn via tmux
- Profiles with `cwd: null` inherit `default_cwd` from config — resolution happens frontend-side

See `backend/CLAUDE.md` and `frontend/CLAUDE.md` for crate/directory-specific details.
