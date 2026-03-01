# Backend

Axum web server that serves the frontend and manages terminal sessions via tmux.

## Structure

- `main.rs` — routes, handlers (`GET/PUT /api/profiles`, `/api/sessions`, websocket upgrade)
- `config.rs` — `ProfileConfig` / `Profile` structs, load/save to `~/.config/codefactory/profiles.json`
- `ws.rs` — per-floor websocket handler, terminal spawn/resize/input messages
- `terminal.rs` — `TerminalManager`, tmux session lifecycle
- `state.rs` — shared `AppState`

## Key Details

- `GET /api/profiles` returns raw `cwd` (null when unset) — frontend resolves the fallback
- `PUT /api/profiles` accepts full `ProfileConfig` (default_cwd + profiles array)
- WebSocket connections are per-floor at `/ws/{floor_id}`
- Terminals are tmux sessions named `codefactory-floor-{id}`
