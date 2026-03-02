#!/bin/bash
# CodeFactory start script
# Clears stale log file and launches the backend

cd "$(dirname "$0")" || exit 1

# Truncate old log (previous session entries are stale)
> /tmp/codefactory.log

echo "Log cleared: /tmp/codefactory.log"
echo "Starting CodeFactory backend on :3001..."

RUST_LOG=codefactory_backend=info,warn exec cargo run
