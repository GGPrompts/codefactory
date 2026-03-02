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

## How It Works

A single `dolt sql-server` process runs on `127.0.0.1:3307` and hosts databases for multiple projects. Each project's `.beads/metadata.json` tells bd which database name to use.

### Architecture

```
dolt sql-server (port 3307)
  └── data-dir: ~/beads-dolt/
        ├── beads_codefactory/     <- one dolt DB per project
        ├── beads_TabzChrome/
        ├── beads_htmlstyleguides/
        ├── beads_pixeloot/
        └── config.yaml            <- server listener config
```

Each project repo has:
```
project/.beads/
  ├── metadata.json    <- points to its dolt database name
  ├── config.yaml      <- beads config (mostly defaults)
  └── dolt/            <- may or may not exist locally
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

## Syncing via ObsidianVault (File-Based Remote)

Beads issues sync between machines using Dolt file-based remotes stored in `~/ObsidianVault/beads-remotes/`. The Obsidian vault sync (Obsidian Sync, iCloud, Syncthing, etc.) handles transport between devices.

```
~/ObsidianVault/beads-remotes/
  ├── beads_codefactory/       <- dolt remote for each project
  ├── beads_TabzChrome/
  ├── beads_htmlstyleguides/
  └── beads_pixeloot/
```

### Daily Workflow

```bash
bd dolt pull          # start of session: pull latest
# ... do work, create/close issues ...
bd dolt push          # end of session: push changes
```

## Setting Up on a New Machine (Desktop)

### 1. Create the shared dolt data directory

```bash
mkdir -p ~/beads-dolt
cd ~/beads-dolt

# Create server config
cat > config.yaml << 'EOF'
listener:
  host: 127.0.0.1
  port: 3307
data_dir: .
EOF
```

### 2. Configure dolt identity

```bash
dolt config --global --add user.email "marcinek.matthew@gmail.com"
dolt config --global --add user.name "GGPrompts"
```

### 3. Initialize databases for each project

```bash
# For each project that uses dolt:
mkdir -p ~/beads-dolt/beads_codefactory
cd ~/beads-dolt/beads_codefactory
dolt init
```

### 4. Start the dolt server

```bash
cd ~/beads-dolt
dolt sql-server --host 127.0.0.1 --port 3307 --data-dir .
```

To run in background:
```bash
cd ~/beads-dolt
nohup dolt sql-server --host 127.0.0.1 --port 3307 --data-dir . > /tmp/dolt-server.log 2>&1 &
```

### 5. Initialize beads in each project

```bash
cd ~/projects/codefactory
bd init --prefix codefactory --server
bd dolt show
# Should show: Server connection OK, Database: beads_codefactory
```

### 6. Add the ObsidianVault remote

```bash
# Create remote directories
mkdir -p ~/ObsidianVault/beads-remotes/beads_codefactory

# Add remote to each dolt database
cd ~/beads-dolt/beads_codefactory
dolt remote add origin file:///home/marci/ObsidianVault/beads-remotes/beads_codefactory
dolt push origin main
```

### 7. Pull existing data from the other machine

If the other machine (laptop) has already pushed its data to the remotes, the desktop needs to replace its fresh `dolt init` databases with that data. A regular `dolt pull` will fail because the histories diverged (empty init vs. laptop's history).

**Fix: force reset each database to match the remote:**

```bash
# Stop the dolt server first, then for each database:
for db in ~/beads-dolt/beads_*/; do
  echo "=== $(basename $db) ==="
  cd "$db"
  dolt fetch origin
  dolt reset --hard origin/main
  cd ~
done
# Restart the dolt server after
```

If `dolt reset --hard` doesn't work, the nuclear option is to delete and re-clone:

```bash
# Stop the dolt server first
cd ~/beads-dolt
rm -rf beads_codefactory
dolt clone file:///path/to/ObsidianVault/beads-remotes/beads_codefactory
# Repeat for each database, then restart the server
```

## Setting Up on the Laptop (Adding Remotes)

The laptop already has beads and dolt working. Just need to add the ObsidianVault remotes and push.

### 1. Find the dolt data directory

```bash
# Check where the dolt server is running from:
ps aux | grep dolt
# Look for --data-dir or the cwd of the process
# On laptop it was: ~/projects/htmlstyleguides/.beads/dolt/
```

### 2. Create remote directories and add remotes

```bash
# Create the remote directories in ObsidianVault
mkdir -p ~/ObsidianVault/beads-remotes/beads_codefactory
mkdir -p ~/ObsidianVault/beads-remotes/beads_TabzChrome
mkdir -p ~/ObsidianVault/beads-remotes/beads_htmlstyleguides
mkdir -p ~/ObsidianVault/beads-remotes/beads_pixeloot

# For each project, go to its dolt database directory and add the remote:
# (The database dirs are subdirectories of the dolt server's data-dir)

cd ~/projects/htmlstyleguides/.beads/dolt/beads_codefactory
dolt remote add origin file:///home/marci/ObsidianVault/beads-remotes/beads_codefactory
dolt push origin main

cd ~/projects/htmlstyleguides/.beads/dolt/beads_TabzChrome
dolt remote add origin file:///home/marci/ObsidianVault/beads-remotes/beads_TabzChrome
dolt push origin main

# Repeat for each project...
```

### 3. Verify

```bash
cd ~/projects/codefactory
bd dolt push    # should push to the file remote via ObsidianVault
```

## Projects Using Dolt

| Project | Database Name |
|---------|--------------|
| codefactory | beads_codefactory |
| TabzChrome | beads_TabzChrome |
| htmlstyleguides | beads_htmlstyleguides |
| pixeloot | beads_pixeloot |

Other projects still use local SQLite (`beads.db`) and aren't synced.

## Troubleshooting

- **Connection refused**: Make sure `dolt sql-server` is running on port 3307
- **Database not found**: The database directory needs to exist in the data-dir. Run `dolt init` inside `~/beads-dolt/<database_name>/`
- **table not found: issues**: The beads schema isn't initialized. Run `bd init --prefix <name> --server` from the project directory
- **bd dolt show**: Quick way to verify connection and config
- **bd dolt test**: Tests the server connection
- **bd dolt push fails with "no store available"**: Use `dolt push origin main` directly from the database directory instead
- **Diverged histories after setup**: If both machines initialized independently, the laptop's data is the source of truth. On the desktop, stop the server, then `dolt fetch origin && dolt reset --hard origin/main` in each database dir, then restart the server
- **Force push from laptop**: If the desktop overwrote remotes with empty inits, run `dolt push --force origin main` from each database dir on the laptop, commit+push ObsidianVault, then pull on desktop
- **Laptop database locations**: Not all databases are in one data-dir. Some may be at `~/projects/<project>/.beads/dolt/<db_name>/` depending on which project initialized the server. Use `ps aux | grep dolt` to find the server's data-dir, and check each project's `.beads/dolt/` for additional databases
