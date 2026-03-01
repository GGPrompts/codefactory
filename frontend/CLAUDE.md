# Frontend

Vanilla JS/HTML/CSS — no build step, served directly by the backend.

## Files

- `index.html` — single page with lobby + dynamic floor sections
- `js/app.js` — profile fetching, floor rendering, elevator mechanics, lobby workdir selector, edit mode, page floor lifecycle
- `js/terminal.js` — xterm.js terminal lifecycle, websocket connection per floor
- `js/markdown-panel.js` — side panel markdown rendering
- `css/style.css` — all styles, industrial theme via CSS custom properties
- `css/industrial-prose.css` — markdown content styles

## Floor Rendering

- `buildFloorHTML()` dispatches to `buildTerminalFloorHTML()` or `buildPageFloorHTML()` based on `profile.page`
- `buildEditFormHTML()` is shared — includes PAGE input field for both floor types
- `renderFloors()` filters out profiles with `enabled === false` before rendering
- Page floors auto-load on startup via `autoLoadPageFloors()` (no power-on click needed)

## Page Floor Functions

- `powerOnPage(floorId, profile)` — creates iframe with `src=/api/pages/{encoded_path}`, sets powered-on state
- `powerOffPage(floorId)` — removes iframe, resets to powered-off state
- Page floors have a simpler power-off bar (just `[POWER OFF]`, no detach/kill)

## Conventions

- ES5-style: `var`, IIFEs, `function` declarations, `.forEach` (no arrow functions)
- Two global namespaces exposed: `CodeFactoryTerminals` (terminal.js) and `MarkdownPanel` (markdown-panel.js)
- `app.js` is a self-contained IIFE — all state is module-scoped
- Profile cwd resolution: `profile.cwd || defaultCwd || '~'` — null means inherit from lobby setting
- Floor HTML is built as string concatenation
- Reconnect logic skips page floors (no tmux sessions to reconnect)
