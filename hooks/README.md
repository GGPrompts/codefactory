# Claude Code Hooks for CodeFactory

## state-tracker.sh (Desktop)

Full-featured state tracker for desktop/laptop with tmux pane management, audio announcements, and debug logging.

## state-tracker-termux.sh (Termux/Android)

Lightweight version for Termux — no tmux pane cleanup, no audio announcer, no debug file dumps. Uses `$TMPDIR` (required on Termux since `/tmp` is inaccessible).

### Dependencies

- `bash`, `jq`, `coreutils` (for `timeout`)
- On Termux: `pkg install jq coreutils`

### Setup

Add hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/projects/codefactory/hooks/state-tracker-termux.sh pre-tool", "timeout": 1 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/projects/codefactory/hooks/state-tracker-termux.sh post-tool", "timeout": 1 }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/projects/codefactory/hooks/state-tracker-termux.sh stop", "timeout": 1 }] }
    ],
    "SubagentStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/projects/codefactory/hooks/state-tracker-termux.sh subagent-start", "timeout": 1 }] }
    ],
    "SubagentStop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/projects/codefactory/hooks/state-tracker-termux.sh subagent-stop", "timeout": 1 }] }
    ],
    "Notification": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "~/projects/codefactory/hooks/state-tracker-termux.sh notification", "timeout": 1 }] }
    ]
  }
}
```

For the desktop version, replace `state-tracker-termux.sh` with `state-tracker.sh` and add `SessionStart` and `UserPromptSubmit` hooks as well.

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
