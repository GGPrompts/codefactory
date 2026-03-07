# Frontend

Vanilla JS/HTML/CSS — no build step, served directly by the backend.

## Files

### Core

- `index.html` — single page with lobby + dynamic floor sections
- `js/app.js` — profile fetching, floor rendering, elevator mechanics, lobby workdir selector, edit mode, page floor lifecycle, mobile bottom bar, keyboard shortcuts
- `js/terminal.js` — xterm.js terminal lifecycle, websocket connection per floor, Claude session status display
- `js/markdown-panel.js` — side panel markdown rendering
- `css/style.css` — all styles, industrial theme via CSS custom properties
- `css/industrial-prose.css` — markdown content styles
- `css/file-picker.css` — standalone FilePicker modal styles (for use in page floors without loading full style.css)

### Modules

- `js/swipe-panels.js` — `SwipePanels` module: touch/pointer swipe detection from screen edges, shows/hides registered panel content per edge
- `js/extra-keys.js` — `ExtraKeys` module: mobile extra key row (ESC, TAB, CTRL, ALT, arrows, PgUp, F1-F10, Ctrl-B, Enter) with sticky modifier support (tap = one-shot, double-tap = lock)
- `js/file-picker.js` — `FilePicker` module: reusable modal file/directory browser using `/api/files/list`, with breadcrumb nav, hidden file toggle, file/dir mode
- `js/console-forwarder.js` — intercepts `console.log/warn/error/info` and `window.onerror`, batches POSTs to `/api/logs/ingest`
- `js/livereload.js` — development live-reload via WebSocket

### Page-specific JS (loaded by page floors, not index.html)

- `js/beads-board.js` — `BeadsBoard` module: Kanban board reading from `/api/beads/issues`
- `js/git-graph.js` — `GitGraph` module: git commit graph renderer using canvas
- `js/termux-dashboard.js` — Termux dashboard widgets: battery, wifi, volume, brightness, torch, TTS

### PWA

- `service-worker.js` — minimal pass-through worker (no caching), enables install prompt
- `manifest.json` — PWA manifest with icons (192, 512, maskable-512), `display: standalone`

### Page Floors (`pages/`)

- `beads-board.html` — Kanban board for Beads issue tracker (project dropdown via `/api/beads/projects`)
- `git.html` — Git operations (stage, unstage, commit, push, pull, diff viewer)
- `git-tree.html` — Git commit graph visualization using canvas (FilePicker for repo path)
- `diff.html` — Side-by-side diff viewer: uncommitted, vs HEAD, compare two files (FilePicker for file paths)
- `files.html` — File browser with create, rename, delete, preview
- `search.html` — Full-text search across project files
- `terminals.html` — Active terminals dashboard (status dots, context meters, activity, hover history)
- `termux-dashboard.html` — Termux system controls (battery, wifi, volume, brightness, torch, TTS)
- `config.html` — Project config viewer
- `logs.html` — Filterable, color-coded live log viewer via WebSocket
- `markdown.html` — Markdown file renderer
- `notes.html` — Notes editor
- `ports.html` — Port/process monitor
- `processes.html` — System process viewer
- `snippets.html` — Code snippet manager

## Floor Rendering

- `buildFloorHTML()` dispatches to `buildTerminalFloorHTML()` or `buildPageFloorHTML()` based on `profile.page`
- `buildEditFormHTML()` is shared — includes PAGE input field for both floor types
- `renderFloors()` filters out profiles with `enabled === false` before rendering
- Page floors auto-load on startup via `autoLoadPageFloors()` (no power-on click needed)

## Page Floor Functions

- `powerOnPage(floorId, profile)` — creates iframe with `src=/api/pages/{encoded_path}`, sets powered-on state
- `powerOffPage(floorId)` — removes iframe, resets to powered-off state
- Page floors have a simpler power-off bar (just `[POWER OFF]`, no detach/kill)

## Side Panel Features

- Desktop: resizable via drag handle, width persisted to `localStorage` as `cf-panel-width-{floorId}`
- Open/closed state persisted to `localStorage` as `cf-panel-{floorId}`
- Two tabs: REFERENCE (markdown) and TERMINAL (capture view)
- Mobile: markdown panel moves to left swipe edge instead of side panel

## Claude Session Status in UI

- `terminal.js` handles `session-status` WebSocket messages
- Elevator buttons get CSS classes: `claude-awaiting` / `claude-processing` / `claude-idle` (glow effects)
- Floor header shows status badge: AWAITING INPUT / PROCESSING / TOOL USE / ONLINE
- Current tool name shown as suffix on elevator button tooltip
- Initial statuses fetched via `GET /api/session-status` 1.5s after load

## Mobile Bottom Bar

Three horizontally-swipeable panels:
1. **Extra Keys**: ESC, TAB, CTRL, ALT, arrows, PgUp, F1-F10, Ctrl-B, Enter
2. **Chat Input**: text field that sends to focused terminal with 800ms delayed Enter (tuned for Claude Code)
3. **Elevator Nav**: floor buttons for scrolling

## Conventions

- ES5-style: `var`, IIFEs, `function` declarations, `.forEach` (no arrow functions)
- Three global namespaces exposed: `CodeFactoryTerminals` (terminal.js), `MarkdownPanel` (markdown-panel.js), `FilePicker` (file-picker.js)
- `app.js` is a self-contained IIFE — all state is module-scoped
- Profile cwd resolution: `profile.cwd || defaultCwd || '~'` — null means inherit from lobby setting
- Floor HTML is built as string concatenation
- Reconnect logic skips page floors (no tmux sessions to reconnect)
- Recent working directories persisted to `localStorage` as `cf-recent-dirs`
