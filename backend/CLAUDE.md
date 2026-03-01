# Backend

Axum web server that serves the frontend and manages terminal sessions via tmux.

## Structure

- `main.rs` — routes, handlers, session status poller
- `config.rs` — `ProfileConfig` / `Profile` structs, load/save to `~/.config/codefactory/profiles.json`
- `ws.rs` — per-floor websocket handler, terminal spawn/resize/input messages
- `terminal.rs` — `TerminalManager`, tmux session lifecycle
- `state.rs` — shared `AppState`

## API Routes

- `GET /api/profiles` — returns profiles with synthetic `id`, includes `page` and `enabled` fields
- `PUT /api/profiles` — accepts full `ProfileConfig` (default_cwd + profiles array)
- `GET /api/sessions` — list orphaned tmux sessions for reconnection
- `GET /api/session-status` — Claude session status for all floors (polled from state files)
- `GET /api/panels/{*name}` — serve markdown panel files (`text/markdown`)
- `GET /api/pages/{*name}` — serve HTML page files (`text/html`); same path resolution as panels
- `WS /ws/{floor_id}` — per-floor websocket for terminal I/O

## Path Resolution (panels and pages)

- Bare filename → `~/.config/codefactory/panels/` or `pages/` directory
- Absolute or `~`-prefixed path → expanded directly (tilde → `$HOME`)
- Traversal characters (`..`, `/`, `\`) stripped from bare filenames

## Key Details

- `GET /api/profiles` returns raw `cwd` (null when unset) — frontend resolves the fallback
- Profile struct has `page: Option<String>` and `enabled: bool` (defaults to true via `default_true`)
- Terminals are tmux sessions named `codefactory-floor-{id}`
