# Claude Code Hooks for CodeFactory

## state-tracker.sh

Writes Claude's current state (status, tool, context %, working dir) to `/tmp/claude-code-state/{session}.json` on every hook event. CodeFactory reads these files to show Claude session status on elevator buttons and the terminals dashboard.

### Dependencies

- `bash`, `jq`, `timeout` (all available on Termux via `pkg install jq coreutils`)

### Setup

1. Copy the script to the Claude hooks directory:

```bash
mkdir -p ~/.claude/hooks/scripts
cp hooks/state-tracker.sh ~/.claude/hooks/scripts/state-tracker.sh
chmod +x ~/.claude/hooks/scripts/state-tracker.sh
```

2. Add hooks to `~/.claude/settings.json` (merge into existing `hooks` object):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh session-start", "timeout": 2 }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh user-prompt", "timeout": 1 }] }
    ],
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh pre-tool", "timeout": 1 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh post-tool", "timeout": 1 }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh stop", "timeout": 1 }] }
    ],
    "SubagentStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh subagent-start", "timeout": 1 }] }
    ],
    "SubagentStop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh subagent-stop", "timeout": 1 }] }
    ],
    "Notification": [
      { "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "~/.claude/hooks/scripts/state-tracker.sh notification", "timeout": 1 }] }
    ]
  }
}
```

### What it tracks

| Hook Event | Status Written |
|-----------|---------------|
| session-start | `idle` |
| user-prompt | `processing` |
| pre-tool | `tool_use` (with tool name) |
| post-tool | `processing` |
| stop | `awaiting_input` |
| subagent-start/stop | `processing` / `awaiting_input` |
| notification | `awaiting_input` (for idle_prompt) |

### State file format

```json
{
  "session_id": "floor-id-or-hash",
  "status": "awaiting_input",
  "current_tool": "",
  "subagent_count": 0,
  "context_percent": 52,
  "context_window": { "size": 200000, "input_tokens": 97, "output_tokens": 20282 },
  "working_dir": "/home/user/projects/codefactory",
  "last_updated": "2026-03-02T01:16:29Z"
}
```
