# Frontend

Vanilla JS/HTML/CSS — no build step, served directly by the backend.

## Files

- `index.html` — single page with lobby + dynamic floor sections
- `js/app.js` — profile fetching, floor rendering, elevator mechanics, lobby workdir selector, edit mode
- `js/terminal.js` — xterm.js terminal lifecycle, websocket connection per floor
- `js/markdown-panel.js` — side panel markdown rendering
- `css/style.css` — all styles, industrial theme via CSS custom properties
- `css/industrial-prose.css` — markdown content styles

## Conventions

- ES5-style: `var`, IIFEs, `function` declarations, `.forEach` (no arrow functions)
- Two global namespaces exposed: `CodeFactoryTerminals` (terminal.js) and `MarkdownPanel` (markdown-panel.js)
- `app.js` is a self-contained IIFE — all state is module-scoped
- Profile cwd resolution: `profile.cwd || defaultCwd || '~'` — null means inherit from lobby setting
- Floor HTML is built as string concatenation in `buildFloorHTML()`
