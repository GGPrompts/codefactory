# CodeFactory Backlog

Open issues to recreate in beads on new machine. Delete this file after.

---

## 1. Profile config system with global defaults [P1]

**Blocks:** #2, #3

Redesign the floor config system around user profiles:

- Config file at `~/.config/codefactory/profiles.json` (XDG standard, not in project dir)
- Schema:
  ```json
  {
    "default_cwd": "~/projects",
    "profiles": [
      { "name": "Shell", "command": null, "cwd": null },
      { "name": "Dev Server", "command": "npm run dev", "cwd": "~/projects/myapp" }
    ]
  }
  ```
- `null` command = default shell, `null` cwd = uses `default_cwd`
- Backend reads this config on startup
- API endpoints:
  - `GET /api/profiles` - serves the config
  - `PUT /api/profiles` - saves updated config (used by frontend edit form)
- If no config file exists, create one with sensible defaults (3 plain shell profiles named Shell 1, Shell 2, Shell 3)
- Expand `~` to HOME in all paths when spawning sessions
- Remove the old `frontend/config/floors.json` in favor of this
- Config directory created automatically if missing (`~/.config/codefactory/`)

---

## 2. Dynamic floor rendering from profiles [P1]

**Depends on:** #1

Instead of hardcoded 5 floors in index.html, dynamically generate floors based on profiles with power on/off states:

**Floor States:**
- **OFFLINE**: Shows profile info card with name, command, cwd. Two buttons: `[POWER ON]` and `[EDIT]`.
  - POWER ON spawns the terminal session
  - EDIT shows inline form to change name/command/cwd (saves to profiles.json via PUT /api/profiles)
- **ONLINE**: Live xterm.js terminal fills the container. Floor header shows `[POWER OFF]` button.
  - POWER OFF disconnects (preserves tmux session for quick restart)

**Implementation:**
- Frontend fetches `/api/profiles` on load
- JS generates floor sections dynamically for each profile
- Each floor has an offline-content div (profile card + buttons) and terminal-container div
- Only one is visible at a time based on state
- POWER ON: initializes xterm.js, connects WebSocket, sends spawn message, hides offline content, shows terminal
- POWER OFF: sends disconnect message, closes WebSocket, shows offline content, hides terminal
- EDIT mode: replaces profile card with input fields (name, command, cwd), save/cancel buttons
  - Save sends PUT /api/profiles with updated config
  - Cancel returns to profile card view
- Elevator panel buttons generated dynamically to match profile count
- Floor labels populated from profile data, status shows ONLINE/OFFLINE
- Shaft walls generated between floors
- Lobby remains static at the bottom
- Keyboard shortcuts adapt to floor count (1-9 max)
- All elevator mechanics (door animations, scroll detection, active floor) work with dynamic floor count
- Handle edge cases: 0 profiles (just lobby with prompt to add), 1 profile, 9+ profiles
- Terminals are NOT auto-spawned on door open - user must click POWER ON

---

## 3. Ratatui config TUI [P1]

**Depends on:** #1

Build a ratatui-based TUI for managing CodeFactory profiles. Separate binary in the workspace (`codefactory-config` or `cf-config`).

**Features:**
- List all profiles with name, command, cwd in a table view
- Add new profile (name, command, optional cwd)
- Edit existing profile (inline editing)
- Delete profile (with confirmation)
- Reorder profiles (move up/down - determines floor order)
- Set global default_cwd
- First-run auto-detection: scan PATH for common tools (lazygit, htop, btop, claude, codex, tfe, etc.) and suggest profiles
- Keybindings: `a`=add, `e`=edit, `d`=delete, `j/k`=navigate, `J/K`=reorder, `g`=set global cwd, `q`=quit
- Saves to `~/.config/codefactory/profiles.json` (same file the backend reads)
- Can be run standalone OR inside a CodeFactory terminal floor
- Changes are picked up by the backend on next GET /api/profiles (no restart needed)

**Deps:** ratatui, crossterm

Keep it simple and focused - this is a config editor, not a dashboard.

**NOTE:** This TUI is an alternative to the inline edit form on the frontend. Both write to the same config file. The TUI is better for initial setup and bulk changes, the inline edit is better for quick tweaks while using CodeFactory.
