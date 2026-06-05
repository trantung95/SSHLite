# SSH Lite - Full Feature Reference

Every user-facing feature, grouped by area. Each entry says what you **click** in SSH Lite versus what you would otherwise **type** in a terminal, and which panel it lives in.

Back to the [README](../README.md) · Command list: [docs/COMMANDS.md](COMMANDS.md)

## Table of contents

- [Connection and hosts](#connection-and-hosts)
- [File browser and editing](#file-browser-and-editing)
- [Search](#search)
- [Terminal](#terminal)
- [Server monitoring and management](#server-monitoring-and-management)
- [SSH Tools suite](#ssh-tools-suite)
- [Port forwarding](#port-forwarding)
- [Activity, audit, and backups](#activity-audit-and-backups)
- [The pixel coder (Support view)](#the-pixel-coder-support-view)
- [Donate](#donate)
- [Diagnostics and maintenance](#diagnostics-and-maintenance)

---

## Connection and hosts

### Add and connect to hosts
Click **+** in the SSH Lite sidebar, fill the dialog, then click the host to connect. Reads `~/.ssh/config`; supports SSH keys (RSA / Ed25519 / ECDSA, encrypted), agent, and password. *Instead of* `ssh user@host` in a terminal. Lives in the **Host tree**.

### Multi-server management
Connect and disconnect many servers in one window, each colour-coded: green (connected), orange (last connect failed), gray (saved). Hover an orange host for the error and how long ago it failed. Lives in the **Host tree**.

### Host filter
Type a pattern in the host-tree toolbar search box; non-matching hosts gray out with a match count. *Instead of* scrolling a long `~/.ssh/config`.

### Credentials and connection state
Right-click a host to save a password, add a credential, or connect with a specific credential. Credentials are stored in the OS secret store. Clear them per host from the same menu.

### Sudo fallback
Enable Sudo Mode on a host; when a write hits "permission denied", SSH Lite prompts for the sudo password and retries over the **same** SSH connection (no child process, no second login). *Instead of* re-running with `sudo` by hand.

### Pinned and recent folders
Right-click a folder to pin it; jump to pinned/recent paths from the command palette or a sub-tree under the host. *Instead of* retyping `cd /long/path` every session.

---

## File browser and editing

### Browse and edit over SFTP
Click folders to browse; open a file and it opens in your VS Code editor; press `Ctrl+S` and it saves locally then auto-uploads. *Instead of* `vi` / `nano` over the wire. Lives in the **File explorer**.

### Create, rename, and delete
Right-click for New File / New Folder / Rename (or `F2`) / Delete. Every delete creates a timestamped server-side `.bak` first (see [Auto-backup and restore](#auto-backup-and-restore)). *Instead of* `touch` / `mkdir` / `mv` / `rm`.

### Upload and download
Right-click a folder to upload a local file, or a remote file to download it to a chosen location. *Instead of* `scp` / `sftp put` / `sftp get`.

### Copy, cut, and paste across hosts
`Ctrl+C` / `Ctrl+X` / `Ctrl+V` to copy, cut, and paste files - even between different servers - with auto-rename on name conflict. *Instead of* `scp host-a:... host-b:...`.

### File status badges
Inline tree badges show sync state at a glance: uploading, upload failed, and filtered-match counts. No terminal equivalent.

### File properties
Right-click a file for a read-only panel of size, permissions, owner, and timestamps. *Instead of* `stat` / `ls -l`.

### Filter by name
Right-click any folder or whole connection and filter by name; non-matches gray out with a per-folder match count. *Instead of* `find . -name`.

### Jump to any path
`Ctrl+Shift+G` (or the toolbar) to go straight to any remote path; one-click buttons for parent, home, and root; "show tree from root" expands every ancestor of the current folder.

---

## Search

### Multi-server search
One webview searches many servers at once: toggle case / regex / whole-word, add include/exclude patterns, pick which servers, and read results grouped per server with expandable files and line-by-line matches. *Instead of* running `grep -r` separately on every box.

### Find files mode
Toggle the file icon to switch results from content matches to file paths only. *Instead of* `find`.

### Per-server worker threads
A per-server dropdown (1 to 50 processes) tunes search parallelism; cancel anytime. SSH Lite waits for all results so nothing is silently truncated.

---

## Terminal

### Integrated terminals
`Ctrl+Shift+T` (or right-click a host) opens a full PTY terminal tab - TUI apps such as `htop`, `btop`, `fzf`, `tmux`, and `neovim` render correctly. Open many terminals per host with no re-auth (one shared SSH connection).

### Terminal at any folder
Right-click a folder and "Open Terminal Here" to start a shell already `cd`-ed into that directory. *Instead of* logging in then `cd /path`.

---

## Server monitoring and management

### Server monitor
Right-click a host and "Monitor Server" for a live view of CPU, memory, and disk plus the top processes. *Instead of* `htop` / `vmstat` / `df -h`. Opt-in and off by default (no background polling unless you open it).

### Process viewer
"Show Remote Processes" opens a sortable table of PID, user, CPU%, memory, and command; search, filter, and click to kill. *Instead of* `ps aux | grep` then `kill`.

### Service manager
"Manage Remote Service" gives a service picker with start / stop / restart buttons and live status. *Instead of* `systemctl start|stop|restart|status`.

### Environment inspector
"Show Remote Environment" lists every environment variable in a searchable table with copy buttons. *Instead of* `printenv` / `env`.

### Cron editor
"Edit Remote Crontab" opens the crontab in a real editor view; edit and save. *Instead of* `crontab -e` in `vi`.

---

## SSH Tools suite

### SSH key generator and push
Generate an SSH key pair (type + passphrase) from the command palette, then "Push Public Key to Host" to install it on a server. *Instead of* `ssh-keygen` then `ssh-copy-id`.

### Snippet library
Save frequently-used commands, then run a snippet on a host with one click; edit the library in an editor. *Instead of* keeping a notes file of commands.

### Batch command runner
Pick several hosts and run one command across all of them. *Instead of* a hand-rolled `for host in ...; do ssh ...; done` loop.

### Run a local script on the remote
Right-click a host, pick a local script, and SSH Lite uploads and executes it, showing the output. *Instead of* `scp script.sh host:` then `ssh host bash script.sh`.

### Remote diff
Right-click a remote file and "Diff with Local File" for a side-by-side diff (left = remote, right = local) in VS Code's diff editor. *Instead of* `scp` then `diff`.

---

## Port forwarding

### Set up a port forward
Click the forward button in the toolbar and enter local port, remote host, and remote port. *Instead of* `ssh -L 3000:localhost:3000 user@host`.

### Active and saved forwards
Active forwards appear in a tree (`host:3000 <-> localhost:3000`); they are persisted, so a dimmed saved rule re-activates with one click. Right-click to stop. Visible state instead of a hidden `ssh -L` process.

---

## Activity, audit, and backups

### Activity panel
Every operation (upload, download, search, terminal, monitor) shows up in the Activity tree with a spinner while running, a checkmark when done, an X on failure, and a duration. Group by server or flat.

### Audit log
"Show Audit Log" opens the recorded JSON-lines log of every SSH operation in an editor. No terminal equivalent.

### Auto-backup and restore
Every destructive op (delete / overwrite) silently writes a timestamped server-side `.bak` first. "Show File Backup History" or "Show Server Backups" lists them; click to restore or view the diff. *Instead of* remembering to `cp file file.bak` by hand.

---

## The pixel coder (Support view)

### Animated coder and cheering banner
A canvas-drawn pixel coder sits in the Support view, types along as you type, and follows your cursor. It tells real typing from another tool's edits, so when Claude Code (or a formatter) writes a file it shows that tool's label, not yours. It can also wear a tilted Vietnam-flag "băng cổ động" headband across its forehead (the flag off to one side, with a short text of your choice up to 5 characters), which zooms in, lingers, then zooms out. It is **off by default** — a dropdown in the gear → NPC settings sets it to Sometimes, Always, or Never. Purely for fun.

### AI hooks
From the Support view gear, "set up AI hooks" auto-installs prompt-submit hooks into supported AI CLIs (Claude Code, Codex, Gemini, Cursor, Copilot) so the coder literally flies your real prompt text across the screen. Status is shown per tool.

---

## Donate

### Banh Mi donate panel
The donate webview plays a short animated cooking sequence, then shows QR codes and copy buttons for crypto addresses (Solana and TON chains). A Vietnamese sandwich theme, entirely optional.

---

## Diagnostics and maintenance

### Quick status and diagnostics
"Quick Status" runs a batch of read-only server commands and prints a summary; "Diagnose Slowness" breaks down connection, file-op, and search timings. *Instead of* assembling `uptime` / `df` / `free` / `who` by hand.

### Cache and temp management
Toolbar buttons refresh the tree, clear the cache (factory reset), clear temp files (all or per host), and open the local temp folder.
