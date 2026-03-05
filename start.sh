#!/data/data/com.termux/files/usr/bin/bash
# CodeFactory start script
# Clears stale log file and launches the backend

# Source bashrc for env vars (BD_POSTGRES_URL, etc.) when run outside a login shell
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

cd "$(dirname "$0")" || exit 1

# Kill existing backend if running
EXISTING=$(pgrep -f 'target/(debug|release)/codefactory-backend')
if [ -n "$EXISTING" ]; then
    echo "Killing existing backend (PID $EXISTING)..."
    kill $EXISTING 2>/dev/null
    sleep 1
fi

# Truncate old log (previous session entries are stale)
LOG_FILE="${TMPDIR:-/tmp}/codefactory.log"
> "$LOG_FILE"

echo "Log cleared: $LOG_FILE"
echo "Starting CodeFactory backend on :3001..."

echo "Building release binary..."
cargo build --release --package codefactory-backend 2>&1
if [ $? -ne 0 ]; then
    echo "Build failed, falling back to debug mode..."
    RUST_LOG=codefactory_backend=info,warn exec cargo run
else
    echo "Starting release build..."
    RUST_LOG=codefactory_backend=info,warn exec ./target/release/codefactory-backend
fi
