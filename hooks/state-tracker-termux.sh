#!/data/data/com.termux/files/usr/bin/bash
# Claude Code State Tracker (Termux)
# Lightweight version for Android/Termux — no tmux pane cleanup, no audio.
# Writes Claude's current state to files that CodeFactory can read.

set -euo pipefail

# Configuration — TMPDIR is required on Termux (no /tmp access)
STATE_DIR="${TMPDIR:-/tmp}/claude-code-state"
SUBAGENT_DIR="$STATE_DIR/subagents"
mkdir -p "$STATE_DIR" "$SUBAGENT_DIR"

# Read stdin if available (contains hook data from Claude)
STDIN_DATA=$(timeout 0.1 cat 2>/dev/null || echo "")

# Session identifier: env var > working directory hash > PID
if [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
    SESSION_ID="$CLAUDE_SESSION_ID"
elif [[ -n "${TMUX_PANE:-}" ]]; then
    SESSION_ID=$(echo "$TMUX_PANE" | sed 's/[^a-zA-Z0-9_-]/_/g')
elif [[ -n "$PWD" ]]; then
    SESSION_ID=$(echo "$PWD" | md5sum | cut -d' ' -f1 | head -c 12)
else
    SESSION_ID="$$"
fi

STATE_FILE="$STATE_DIR/${SESSION_ID}.json"
SUBAGENT_COUNT_FILE="$SUBAGENT_DIR/${SESSION_ID}.count"

get_subagent_count() {
    cat "$SUBAGENT_COUNT_FILE" 2>/dev/null || echo "0"
}

increment_subagent_count() {
    (
        flock -x 200
        local count=$(cat "$SUBAGENT_COUNT_FILE" 2>/dev/null || echo "0")
        echo $((count + 1)) > "$SUBAGENT_COUNT_FILE"
    ) 200>"$SUBAGENT_COUNT_FILE.lock"
}

decrement_subagent_count() {
    (
        flock -x 200
        local count=$(cat "$SUBAGENT_COUNT_FILE" 2>/dev/null || echo "0")
        local new_count=$((count - 1))
        [[ $new_count -lt 0 ]] && new_count=0
        echo "$new_count" > "$SUBAGENT_COUNT_FILE"
    ) 200>"$SUBAGENT_COUNT_FILE.lock"
}

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOOK_TYPE="${1:-unknown}"

case "$HOOK_TYPE" in
    session-start)
        STATUS="idle"
        CURRENT_TOOL=""
        DETAILS='{"event":"session_started"}'
        echo "0" > "$SUBAGENT_COUNT_FILE"
        # Clean up stale state files (older than 1 hour) in background
        (
            for file in "$STATE_DIR"/*.json; do
                [[ -f "$file" ]] || continue
                filename=$(basename "$file" .json)
                if [[ "$filename" == *-context ]]; then continue; fi
                file_age=$(($(date +%s) - $(stat -c %Y "$file" 2>/dev/null || echo 0)))
                if [[ $file_age -gt 3600 ]]; then rm -f "$file"; fi
            done
            for file in "$STATE_DIR"/*-context.json; do
                [[ -f "$file" ]] || continue
                file_age=$(($(date +%s) - $(stat -c %Y "$file" 2>/dev/null || echo 0)))
                parent_file="${file/-context.json/.json}"
                if [[ ! -f "$parent_file" ]] || [[ $file_age -gt 3600 ]]; then
                    rm -f "$file"
                fi
            done
        ) &
        ;;
    user-prompt)
        STATUS="processing"
        CURRENT_TOOL=""
        PROMPT=$(echo "$STDIN_DATA" | jq -r '.prompt // "unknown"' 2>/dev/null || echo "unknown")
        DETAILS=$(jq -n --arg prompt "$PROMPT" '{event:"user_prompt_submitted",last_prompt:$prompt}')
        ;;
    pre-tool)
        STATUS="tool_use"
        CURRENT_TOOL=$(echo "$STDIN_DATA" | jq -r '.tool_name // .tool // .name // "unknown"' 2>/dev/null || echo "unknown")
        TOOL_ARGS_STR=$(echo "$STDIN_DATA" | jq -c '.tool_input // .input // .parameters // {}' 2>/dev/null || echo '{}')
        DETAILS=$(jq -n --arg tool "$CURRENT_TOOL" --arg args "$TOOL_ARGS_STR" '{event:"tool_starting",tool:$tool,args:($args|fromjson)}' 2>/dev/null || echo '{"event":"tool_starting"}')
        ;;
    post-tool)
        STATUS="processing"
        CURRENT_TOOL=$(echo "$STDIN_DATA" | jq -r '.tool_name // .tool // .name // "unknown"' 2>/dev/null || echo "unknown")
        TOOL_ARGS_STR=$(echo "$STDIN_DATA" | jq -c '.tool_input // .input // .parameters // {}' 2>/dev/null || echo '{}')
        DETAILS=$(jq -n --arg tool "$CURRENT_TOOL" --arg args "$TOOL_ARGS_STR" '{event:"tool_completed",tool:$tool,args:($args|fromjson)}' 2>/dev/null || echo '{"event":"tool_completed"}')
        ;;
    stop)
        STATUS="awaiting_input"
        CURRENT_TOOL=""
        DETAILS='{"event":"claude_stopped","waiting_for_user":true}'
        ;;
    subagent-start)
        increment_subagent_count
        SUBAGENT_COUNT=$(get_subagent_count)
        STATUS="processing"
        CURRENT_TOOL=""
        AGENT_TYPE=$(echo "$STDIN_DATA" | jq -r '.agent_type // "unknown"' 2>/dev/null || echo "unknown")
        DETAILS=$(jq -n --arg type "$AGENT_TYPE" --arg count "$SUBAGENT_COUNT" '{event:"subagent_started",agent_type:$type,active_subagents:($count|tonumber)}')
        ;;
    subagent-stop)
        decrement_subagent_count
        SUBAGENT_COUNT=$(get_subagent_count)
        CURRENT_TOOL=""
        if [[ "$SUBAGENT_COUNT" -eq 0 ]]; then
            STATUS="awaiting_input"
            DETAILS='{"event":"subagent_stopped","remaining_subagents":0,"all_complete":true}'
        else
            STATUS="processing"
            DETAILS=$(jq -n --arg count "$SUBAGENT_COUNT" '{event:"subagent_stopped",remaining_subagents:($count|tonumber)}')
        fi
        ;;
    notification)
        NOTIF_TYPE=$(echo "$STDIN_DATA" | jq -r '.notification_type // "unknown"' 2>/dev/null || echo "unknown")
        case "$NOTIF_TYPE" in
            idle_prompt|awaiting-input)
                STATUS="awaiting_input"
                CURRENT_TOOL=""
                DETAILS='{"event":"awaiting_input_bell"}'
                ;;
            permission_prompt)
                if [[ -f "$STATE_FILE" ]]; then
                    STATUS=$(jq -r '.status // "idle"' "$STATE_FILE")
                    CURRENT_TOOL=$(jq -r '.current_tool // ""' "$STATE_FILE")
                else
                    STATUS="idle"
                    CURRENT_TOOL=""
                fi
                DETAILS='{"event":"permission_prompt"}'
                ;;
            *)
                if [[ -f "$STATE_FILE" ]]; then
                    STATUS=$(jq -r '.status // "idle"' "$STATE_FILE")
                    CURRENT_TOOL=$(jq -r '.current_tool // ""' "$STATE_FILE")
                else
                    STATUS="idle"
                    CURRENT_TOOL=""
                fi
                DETAILS=$(jq -n --arg type "$NOTIF_TYPE" '{event:"notification",type:$type}')
                ;;
        esac
        ;;
    *)
        if [[ -f "$STATE_FILE" ]]; then
            STATUS=$(jq -r '.status // "idle"' "$STATE_FILE")
            CURRENT_TOOL=$(jq -r '.current_tool // ""' "$STATE_FILE")
        else
            STATUS="idle"
            CURRENT_TOOL=""
        fi
        DETAILS=$(jq -n --arg hook "$HOOK_TYPE" '{event:"unknown_hook",hook:$hook}')
        ;;
esac

SUBAGENT_COUNT=$(get_subagent_count)

# Try to get context data from the context file written by the statusline script
CONTEXT_PERCENT="null"
CONTEXT_WINDOW_SIZE="null"
TOTAL_INPUT_TOKENS="null"
TOTAL_OUTPUT_TOKENS="null"
CLAUDE_SESSION_ID=""

if [[ -f "$STATE_FILE" ]]; then
    CLAUDE_SESSION_ID=$(jq -r '.claude_session_id // ""' "$STATE_FILE" 2>/dev/null || echo "")
fi

if [[ -n "$CLAUDE_SESSION_ID" ]]; then
    CONTEXT_FILE="$STATE_DIR/${CLAUDE_SESSION_ID}-context.json"
    if [[ -f "$CONTEXT_FILE" ]]; then
        CONTEXT_AGE=$(($(date +%s) - $(stat -c %Y "$CONTEXT_FILE" 2>/dev/null || echo 0)))
        if [[ $CONTEXT_AGE -lt 60 ]]; then
            CONTEXT_PERCENT=$(jq -r '.context_pct // "null"' "$CONTEXT_FILE" 2>/dev/null || echo "null")
            CONTEXT_WINDOW_SIZE=$(jq -r '.context_window.context_window_size // "null"' "$CONTEXT_FILE" 2>/dev/null || echo "null")
            TOTAL_INPUT_TOKENS=$(jq -r '.context_window.total_input_tokens // "null"' "$CONTEXT_FILE" 2>/dev/null || echo "null")
            TOTAL_OUTPUT_TOKENS=$(jq -r '.context_window.total_output_tokens // "null"' "$CONTEXT_FILE" 2>/dev/null || echo "null")
        fi
    fi
fi

# Build and write state JSON
cat > "$STATE_FILE" <<EOF
{
  "session_id": "$SESSION_ID",
  "claude_session_id": $(if [[ -n "$CLAUDE_SESSION_ID" ]]; then echo "\"$CLAUDE_SESSION_ID\""; else echo "null"; fi),
  "status": "$STATUS",
  "current_tool": "$CURRENT_TOOL",
  "subagent_count": $SUBAGENT_COUNT,
  "context_percent": $CONTEXT_PERCENT,
  "context_window": {
    "size": $CONTEXT_WINDOW_SIZE,
    "input_tokens": $TOTAL_INPUT_TOKENS,
    "output_tokens": $TOTAL_OUTPUT_TOKENS
  },
  "working_dir": "$PWD",
  "last_updated": "$TIMESTAMP",
  "pid": $$,
  "hook_type": "$HOOK_TYPE",
  "details": $DETAILS
}
EOF

exit 0
