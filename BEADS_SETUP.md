# Beads + Dolt Setup Guide

Instructions for setting up beads with Dolt on a new machine (e.g., desktop) so issues sync with the laptop.

## Prerequisites

Install both tools:
```bash
# Install beads (bd)
# Binary goes to ~/.local/bin/bd
# See https://github.com/GGPrompts/beads for install instructions

# Install dolt
# Binary goes to ~/.local/bin/dolt
# See https://docs.dolthub.com/introduction/installation
```

Versions on laptop: `bd v0.56.1`, `dolt v1.82.6`

## How It Works on the Laptop

A single `dolt sql-server` process runs on `127.0.0.1:3307` and hosts databases for multiple projects. Each project's `.beads/metadata.json` tells bd which database name to use.

### Architecture

```
dolt sql-server (port 3307)
  └── data-dir: ~/projects/htmlstyleguides/.beads/dolt/
        ├── beads_codefactory/     ← one dolt DB per project
        ├── beads_TabzChrome/
        ├── beads_htmlstyleguides/
        ├── beads_pixeloot/
        └── config.yaml            ← server listener config
```

Each project repo has:
```
project/.beads/
  ├── metadata.json    ← points to its dolt database name
  ├── config.yaml      ← beads config (mostly defaults)
  └── dolt/            ← may or may not exist locally
```

### Per-Project metadata.json (Dolt-enabled)

```json
{
  "database": "dolt",
  "jsonl_export": "issues.jsonl",
  "backend": "dolt",
  "dolt_mode": "server",
  "dolt_database": "beads_codefactory"
}
```

## Setting Up on Desktop

### 1. Pick a data directory

Choose where the shared dolt data dir will live. On the laptop it ended up at `~/projects/htmlstyleguides/.beads/dolt/` but any location works. A cleaner choice:

```bash
mkdir -p ~/beads-dolt
cd ~/beads-dolt
```

### 2. Initialize the dolt server config

```bash
cd ~/beads-dolt

# Create server config
cat > config.yaml << 'EOF'
listener:
  host: 127.0.0.1
  port: 3307
data_dir: .
EOF
```

### 3. Start the dolt server

```bash
cd ~/beads-dolt
dolt sql-server --host 127.0.0.1 --port 3307 --data-dir .
```

To run in background (e.g., via systemd or tmux):
```bash
nohup dolt sql-server --host 127.0.0.1 --port 3307 --data-dir . &
```

### 4. Initialize beads in a project

```bash
cd ~/projects/codefactory
bd init --prefix=cf
```

Then update `.beads/metadata.json` to use dolt:
```json
{
  "database": "dolt",
  "jsonl_export": "issues.jsonl",
  "backend": "dolt",
  "dolt_mode": "server",
  "dolt_database": "beads_codefactory"
}
```

### 5. Test the connection

```bash
bd dolt show
# Should show: ✓ Server connection OK
```

## Syncing Between Machines

To share issues between laptop and desktop, you need a dolt remote (DoltHub or file-based).

### Option A: DoltHub Remote

```bash
# On each machine, inside the dolt database directory:
cd ~/beads-dolt/beads_codefactory
dolt remote add origin https://doltremoteapi.dolthub.com/GGPrompts/beads_codefactory

# Then use bd commands to sync:
bd dolt push    # push local changes
bd dolt pull    # pull remote changes
```

### Option B: File-Based Remote (shared drive/NFS)

```bash
cd ~/beads-dolt/beads_codefactory
dolt remote add origin file:///path/to/shared/drive/beads_codefactory
```

### Daily Workflow

```bash
bd dolt pull          # start of session: pull latest
# ... do work, create/close issues ...
bd dolt push          # end of session: push changes
```

## Projects Using Dolt (on laptop)

| Project | Database Name |
|---------|--------------|
| codefactory | beads_codefactory |
| TabzChrome | beads_TabzChrome |
| htmlstyleguides | beads_htmlstyleguides |
| pixeloot | beads_pixeloot |

Other projects still use local SQLite (`beads.db`) and aren't synced.

## Troubleshooting

- **Connection refused**: Make sure `dolt sql-server` is running on port 3307
- **Database not found**: The database directory needs to exist in the data-dir. Run `bd init` or create it with `dolt init` inside the data-dir
- **bd dolt show**: Quick way to verify connection and config
- **bd dolt test**: Tests the server connection
