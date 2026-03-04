#!/bin/bash
# CodeFactory start script
# Clears stale log file and launches the backend

cd "$(dirname "$0")" || exit 1

# Kill existing backend if running
EXISTING=$(pgrep -f 'target/(debug|release)/codefactory-backend')
if [ -n "$EXISTING" ]; then
    echo "Killing existing backend (PID $EXISTING)..."
    kill $EXISTING 2>/dev/null
    sleep 1
fi

# Truncate old log (previous session entries are stale)
> /tmp/codefactory.log

echo "Log cleared: /tmp/codefactory.log"
echo "Starting CodeFactory backend on :3001..."

RUST_LOG=codefactory_backend=info,warn exec cargo run
