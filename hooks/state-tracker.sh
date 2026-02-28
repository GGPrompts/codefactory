#!/usr/bin/env bash
# CodeFactory State Tracker Hook for Claude Code
#
# This script is designed to be called by Claude Code's hook system.
# It writes session state JSON to /tmp/claude-code-state/{session_id}.json
# so the CodeFactory backend can poll for status changes.
#
# Environment:
#   CODEFACTORY_SESSION_ID  - Floor ID (set by CodeFactory backend when spawning tmux)
#   CLAUDE_HOOK_EVENT       - Hook event name from Claude Code
#
# Hook events mapped to states:
#   on_tool_start        -> tool_use   (current_tool from $CLAUDE_TOOL_NAME)
#   on_tool_end          -> processing
#   on_subagent_start    -> processing (increments subagent_count)
#   on_subagent_end      -> processing (decrements subagent_count)
#   on_prompt_start      -> processing
#   on_prompt_end        -> awaiting_input
#   on_idle              -> idle
#   on_stop              -> idle
#
# Usage in .claude/hooks.json:
#   {
#     "hooks": {
#       "on_tool_start":    [{ "command": "/path/to/hooks/state-tracker.sh" }],
#       "on_tool_end":      [{ "command": "/path/to/hooks/state-tracker.sh" }],
#       "on_subagent_start":[{ "command": "/path/to/hooks/state-tracker.sh" }],
#       "on_subagent_end":  [{ "command": "/path/to/hooks/state-tracker.sh" }],
#       "on_prompt_start":  [{ "command": "/path/to/hooks/state-tracker.sh" }],
#       "on_prompt_end":    [{ "command": "/path/to/hooks/state-tracker.sh" }],
#       "on_stop":          [{ "command": "/path/to/hooks/state-tracker.sh" }]
#     }
#   }

set -euo pipefail

SESSION_ID="${CODEFACTORY_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
    # Not running inside CodeFactory, silently exit
    exit 0
fi

STATE_DIR="/tmp/claude-code-state"
STATE_FILE="${STATE_DIR}/${SESSION_ID}.json"
COUNTER_FILE="${STATE_DIR}/${SESSION_ID}.subagent_count"

mkdir -p "$STATE_DIR"

EVENT="${CLAUDE_HOOK_EVENT:-unknown}"
TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
TMUX_PANE="${TMUX_PANE:-}"

# Track subagent count via a simple counter file
get_subagent_count() {
    if [ -f "$COUNTER_FILE" ]; then
        cat "$COUNTER_FILE" 2>/dev/null || echo "0"
    else
        echo "0"
    fi
}

set_subagent_count() {
    echo "$1" > "$COUNTER_FILE"
}

# Determine state and current_tool based on hook event
STATUS="unknown"
CURRENT_TOOL=""
SUBAGENT_COUNT=$(get_subagent_count)

case "$EVENT" in
    on_tool_start)
        STATUS="tool_use"
        CURRENT_TOOL="$TOOL_NAME"
        ;;
    on_tool_end)
        STATUS="processing"
        CURRENT_TOOL=""
        ;;
    on_subagent_start)
        SUBAGENT_COUNT=$(( SUBAGENT_COUNT + 1 ))
        set_subagent_count "$SUBAGENT_COUNT"
        STATUS="processing"
        ;;
    on_subagent_end)
        SUBAGENT_COUNT=$(( SUBAGENT_COUNT > 0 ? SUBAGENT_COUNT - 1 : 0 ))
        set_subagent_count "$SUBAGENT_COUNT"
        STATUS="processing"
        ;;
    on_prompt_start)
        STATUS="processing"
        ;;
    on_prompt_end)
        STATUS="awaiting_input"
        CURRENT_TOOL=""
        ;;
    on_stop|on_idle)
        STATUS="idle"
        CURRENT_TOOL=""
        set_subagent_count 0
        SUBAGENT_COUNT=0
        ;;
    *)
        STATUS="unknown"
        ;;
esac

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Write state atomically (write to temp, then move)
TEMP_FILE="${STATE_FILE}.tmp.$$"
cat > "$TEMP_FILE" <<EOF
{
  "session_id": "${SESSION_ID}",
  "status": "${STATUS}",
  "current_tool": "${CURRENT_TOOL}",
  "subagent_count": ${SUBAGENT_COUNT},
  "last_updated": "${TIMESTAMP}",
  "tmux_pane": "${TMUX_PANE}",
  "hook_event": "${EVENT}"
}
EOF

mv "$TEMP_FILE" "$STATE_FILE"
