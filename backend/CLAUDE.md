# Backend

Axum web server that serves the frontend and manages terminal sessions via tmux.

## Structure

- `main.rs` — routes, handlers, git API, session status poller, Termux API proxy
- `config.rs` — `ProfileConfig` / `Profile` structs, load/save to `~/.config/codefactory/profiles.json`
- `ws.rs` — per-floor websocket handler, terminal spawn/resize/input messages
- `terminal.rs` — `TerminalManager`, tmux session lifecycle
- `state.rs` — shared `AppState`

## API Routes

### Profiles & Sessions

- `GET /api/profiles` — returns profiles with slug-based `id` derived from name, includes `page` and `enabled` fields
- `GET /api/floors` — alias for `/api/profiles` (migration compatibility)
- `PUT /api/profiles` — accepts full `ProfileConfig` (default_cwd + profiles array)
- `GET /api/sessions` — list orphaned tmux sessions for reconnection
- `WS /ws/{floor_id}` — per-floor websocket for terminal I/O

### Claude Session Status

- `GET /api/session-status` — returns `{ statuses, claudeFloors, profiles }`
  - `statuses[]`: floorId, status, currentTool, subagentCount, contextPercent, contextWindow, workingDir, details, lastUpdated
  - `profiles[]`: floorIndex, name, icon, command, enabled, isPage

### Content Serving

- `GET /api/panels/{*name}` — serve markdown panel files (`text/markdown`)
- `GET /api/pages/{*name}` — serve HTML page files (`text/html`); same path resolution as panels; returns `cache-control: no-cache`
- `GET /api/terminal/{session}/capture?lines=` — capture terminal output

### Git Operations

All git routes accept `?path=` query param; `find_git_root()` walks up to find `.git`.

- `GET /api/git/graph?path=&limit=&skip=` — commit graph data
- `GET /api/git/commit/{hash}?path=` — single commit details
- `GET /api/git/diff?path=&file=&staged=&hash=` — diff output
- `GET /api/git/status?path=` — working tree status
- `POST /api/git/fetch?path=` — git fetch
- `POST /api/git/pull?path=` — git pull
- `POST /api/git/push?path=` — git push
- `POST /api/git/stage?path=` — body: `{files, all}`
- `POST /api/git/unstage?path=` — body: `{files, all}`
- `POST /api/git/commit?path=` — body: `{message}`
- `POST /api/git/generate-message?path=` — shells out to `claude --model haiku --print` to generate commit message from staged diff

### Beads

- `GET /api/beads/issues?path=` — list issues from beads
- `GET /api/beads/projects` — list registered project prefixes from ggbd (for dropdown selectors)

### File System

- `GET /api/files/list?path=&dir=` — list directory contents (used by FilePicker)
- `GET /api/files/read?path=` — read file contents
- `POST /api/files/rename` — rename file/directory
- `POST /api/files/delete` — delete file/directory
- `POST /api/files/create` — create file/directory
- `GET /api/files/diff?path=&a=&b=` — diff two files

### Search

- `GET /api/search?path=&q=` — full-text search across files
- `POST /api/search/replace` — search and replace

### Notes

- `GET /api/notes/list` — list notes
- `GET /api/notes/read` — read a note
- `POST /api/notes/save` — save a note
- `POST /api/notes/delete` — delete a note

### Config

- `GET /api/config/list` — list config files
- `GET /api/config/read` — read a config file
- `POST /api/config/write` — write a config file
- `GET /api/config/env` — environment variables

### Processes & Ports

- `GET /api/processes` — list running processes
- `POST /api/processes/kill` — kill a process
- `GET /api/ports` — list listening ports

### Logs

- `POST /api/logs/ingest` — receive frontend console logs
- `GET /api/logs` — retrieve log entries
- `WS /ws/logs` — live log streaming via WebSocket

### Server Control

- `POST /api/shutdown` — graceful server shutdown
- `WS /ws/livereload` — development live-reload notifications

### Termux API (mobile only)

- `GET /api/termux/battery` — battery status
- `GET /api/termux/wifi` — wifi info
- `GET /api/termux/volume` — volume streams
- `POST /api/termux/brightness` — body: `{value}`
- `POST /api/termux/torch` — body: `{enabled}`
- `POST /api/termux/tts` — body: `{text}`

## Path Resolution (panels and pages)

- Bare filename → `~/.config/codefactory/panels/` or `pages/` directory
- Absolute or `~`-prefixed path → expanded directly (tilde → `$HOME`)
- Traversal characters (`..`, `/`, `\`) stripped from bare filenames

## Key Details

- `GET /api/profiles` returns raw `cwd` (null when unset) — frontend resolves the fallback
- Profile struct has `page: Option<String>` and `enabled: bool` (defaults to true via `default_true`)
- Terminals are tmux sessions named `codefactory-floor-{id}`
- When a profile command contains "claude", `ws.rs` prepends `CLAUDE_SESSION_ID={floor_id}` to enable state-file linking
- `ClaudeStateFile` struct reads from `/tmp/claude-code-state/{floorId}.json`; background poller broadcasts changes via WebSocket every 2s
