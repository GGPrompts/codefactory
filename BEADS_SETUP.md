# ggbeads Setup (Supabase/Postgres)

This project uses [ggbeads](https://github.com/GGPrompts/ggbeads) for issue tracking, backed by a shared Supabase Postgres database. All devices share the same cloud DB — no local Dolt server or sync needed.

## How It Works

```
Supabase Postgres (cloud)
  └── shared "beads" schema
        └── all projects' issues, scoped by ID prefix

Each project repo has:
  .beads/
    ├── metadata.json    <- points to Postgres backend
    └── config.yaml      <- beads config (mostly defaults)
```

All projects share one database. Issues are scoped per-project using ID prefixes (e.g., `cf-xxxx` for codefactory, `beads-xxxx` for ggbeads).

### metadata.json (Postgres backend)

```json
{
  "database": "postgres",
  "backend": "postgres",
  "postgres_url_env": "BD_POSTGRES_URL",
  "postgres_schema": "beads"
}
```

## Prerequisites

- Go 1.21+ (with CGO support)
- Python 3.10+ and `uv` (for MCP server)
- `BD_POSTGRES_URL` env var set in `~/.bashrc`

## Setup

Full setup instructions for new machines: `~/ObsidianVault/Configurations/ggbeads-laptop-setup.md`

### Quick reference for this project

```bash
# Build ggbd (if not already built)
cd ~/projects/ggbeads
CGO_ENABLED=1 go build -o ggbd ./cmd/bd/

# Initialize beads in this project (already done)
cd ~/projects/codefactory
ggbd init --prefix cf

# Set the issue prefix in the DB config
ggbd config set issue_prefix cf
```

## Daily Workflow

```bash
# No sync needed — Supabase is always live

# List codefactory issues only
ggbd list --prefix cf

# List all issues across projects
ggbd list

# Create, update, close
ggbd create --title "Fix elevator button styling"
ggbd update cf-xxxx --status in_progress
ggbd close cf-xxxx
```

## MCP Server (Claude Code)

Configured globally in `~/.claude/.mcp.json` with `BD_POSTGRES_URL` and `BEADS_PATH` env vars. Works in all Claude Code sessions.

```bash
# MCP context for this project
context(workspace_root='/home/marci/projects/codefactory', prefix='cf')
```

## Project Prefixes

| Project | Prefix | Example ID |
|---------|--------|------------|
| codefactory | cf | cf-tp59 |
| ggbeads | beads | beads-uq2e |

## Troubleshooting

- **`ggbd list` fails**: Check `BD_POSTGRES_URL` is set (`echo $BD_POSTGRES_URL`)
- **Wrong prefix on new issues**: Verify with `ggbd config get issue_prefix` — should be `cf` for this project
- **MCP "Database: Not found"**: Cosmetic message from `context()` — operations still work via CLI wrapper
- **Stale binary**: Rebuild with `cd ~/projects/ggbeads && CGO_ENABLED=1 go build -o ggbd ./cmd/bd/`

## Migration Notes

Previously used Dolt SQL server on port 3307 with file-based sync via `~/ObsidianVault/beads-remotes/`. Migrated to Supabase Postgres in March 2026. Old Dolt remotes still exist in `~/ObsidianVault/beads-remotes/` as backup.
