# CodeFactory

An industrial-themed terminal elevator built with Rust and xterm.js.

Each floor of the factory opens to reveal a live terminal session backed by tmux, with a Rust (Axum) WebSocket backend bridging xterm.js to persistent tmux sessions.

## Architecture

- **Backend**: Rust (Axum + Tokio) - WebSocket server, PTY/tmux management
- **Frontend**: Vanilla HTML/CSS/JS - Industrial elevator UI with xterm.js terminals
- **Sessions**: tmux for terminal persistence across browser refreshes

## Development

```bash
# Build and run the backend
cargo run

# Backend serves frontend/ as static files on http://localhost:3001
```
