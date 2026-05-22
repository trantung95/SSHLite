# SSH Lite (SSH Tools) — Lightweight SSH Suite for VS Code

![Version](https://img.shields.io/visual-studio-marketplace/v/hybr8.ssh-lite?label=version&color=blue)
![Installs](https://img.shields.io/visual-studio-marketplace/i/hybr8.ssh-lite?color=blue)
![Downloads](https://img.shields.io/visual-studio-marketplace/d/hybr8.ssh-lite?color=blue)
![Rating](https://img.shields.io/visual-studio-marketplace/r/hybr8.ssh-lite?color=blue)
![VS Code](https://img.shields.io/badge/VS%20Code-1.85.0+-purple)
![License](https://img.shields.io/badge/license-Apache--2.0-green)

> Active development. Please report issues on [GitHub](https://github.com/trantung95/SSHLite/issues).

**A visual SSH client for VS Code.** Browse files, edit in your editor, manage services, view processes, edit cron, forward ports — **by clicking, not by typing `vi` / `systemctl` / `crontab -e` / `ps aux | grep`**. Runs entirely over plain SSH/SFTP with **nothing installed on the remote server**. Perfect for VPS, small VMs, shared hosting, and resource-constrained Linux boxes.

![SSH Lite Overview](docs/images/feature-overview.png)

## Why SSH Lite?

Three ways to drive a Linux box from VS Code — pick the one that fits your VPS.

| | SSH Lite | Raw SSH (terminal + vi) | Remote-SSH |
|---|---|---|---|
| Interaction | **Visual** — click to browse, edit, monitor | Type every command | Full IDE feel |
| Remote install | **None** | None | ~200MB+ |
| Edit files | In VS Code | `vi` / `nano` | In VS Code |
| Terminal at any folder | **1-click** — then do whatever in raw shell | login, then `cd /path/...` | open terminal + `cd` |
| Tiny VMs (512MB RAM) | ✓ | ✓ | Often fails |
| Multiple connections | ✓ many in one window | Multiple terminals | 1 per window |
| Server resource usage | **Zero** | Zero | High |

SSH Lite sits in the middle: as light as raw SSH, as friendly as Remote-SSH.

## Features

- **File browser** — SFTP browse / create / edit / rename / **delete (auto-backup)** / upload / download / **Properties**, with tab badges (✓ ↑ ✗) for sync state
- **Filter by name** — instant filter on any folder or full connection in the tree; non-matches grayed, count shown next to the row (per-host, per-folder)
- **Multi-server search** — regex, whole word, include/exclude patterns, results grouped by server (one webview instead of per-host `grep -r`)
- **Integrated terminals** — many per connection, no re-auth
- **Visual SSH Tools suite** — instead of `ps aux` / `systemctl` / `printenv` / `crontab -e` / `diff` / `ssh-keygen`, click through process viewer, service manager, env inspector, cron editor, snippet library, batch runner, script runner, key manager (generate + push), and remote diff
- **Port forwarding** + **server monitor** (CPU / memory / disk / top processes) — visible state, click to stop
- **Remote copy / paste** — `Ctrl+C` / `Ctrl+X` / `Ctrl+V` across hosts, auto-renames on conflict
- **Auto-backup on every destructive op** — every delete / overwrite creates a timestamped `.bak`; restore via right-click → "Show Server Backups"
- **Sudo fallback** — when a write hits permission denied, prompts for sudo password and retries over the same SSH connection (no child process, no second login)
- **Audit log + Activity panel** — every SSH op recorded; cancel running operations from the Activity tree
- **Folder pin + recent folders** — quick jump to frequently-used paths per host

## Quick Start

1. Install — search "SSH Lite" in Extensions, or `code --install-extension hybr8.ssh-lite`
2. Click **+** in the SSH Lite sidebar, add a host
3. Click the host to connect — credentials are saved automatically

Reads `~/.ssh/config`. Supports SSH keys (RSA / Ed25519 / ECDSA, encrypted), agent, and password.

**103 commands** — full reference at [docs/COMMANDS.md](https://github.com/trantung95/SSHLite/blob/master/docs/COMMANDS.md).

## Remote-SSH compatibility

SSH Lite prefers to run on **your local machine** — Windows, macOS, or Linux — even when VS Code is connected to a remote workspace via the built-in Remote-SSH extension. When you install SSH Lite from the Marketplace inside a Remote-SSH session, you will see the **Install in Local** button on the extension page — click it. SSH Lite then connects to remote servers directly from your local machine and downloads files to your local home directory:

- **Windows**: `C:\Users\<you>\...`
- **macOS**: `/Users/<you>/...`
- **Linux**: `/home/<you>/...`

Side-by-side use works without surprises: keep your Remote-SSH editing session on remote server **A**, and use SSH Lite to browse, download from, terminal into, and port-forward from any number of other servers **B**, **C**, **D** — all from your own machine. File browsing, editing, terminals, port forwards, search, snippets, cron, diffs, and the rest of the SSH Tools suite all operate over SSH Lite's own SSH/SFTP connections, independent of where the VS Code workspace lives or which OS you run VS Code on.

Two edge cases worth knowing:

- **Port forwards bind to your local machine.** A process running inside the Remote-SSH workspace (e.g. `curl` in the Remote-SSH terminal) cannot reach the forwarded port. Use VS Code's built-in Remote-SSH port forwarding for that direction.
- **Chained SSH (rare).** If you specifically want to run SSH Lite *from* the remote server to a third server, install SSH Lite on the workspace host as well. SSH Lite will detect this and show a one-time hint pointing you back to Install in Local; dismiss it with the `sshLite.suppressLocalInstallHint` setting.

## Release Notes

**0.8.17** — **Remote-SSH compatibility**: SSH Lite now declares `extensionKind` so it installs on your local machine by default, even when VS Code is connected to a remote host via Remote-SSH. Downloads now route through `vscode.workspace.fs` and land correctly regardless of URI scheme.

- **Local-first install** — the Extensions page shows an **Install in Local** button inside Remote-SSH sessions. SSH connections originate from your machine; downloads land on your filesystem.
- **Download bug fixed** — `Download` and `Download Folder` previously misbehaved on workspace-installed setups (file ended up in `/tmp/<vscode-tmp-id>/`, not the path you picked). All write paths now use `vscode.workspace.fs.writeFile` / `createDirectory`, respecting `file:`, `vscode-remote:`, and custom `FileSystemProvider` schemes.
- **Workspace-host hint** — if SSH Lite is installed on a remote workspace host inside Remote-SSH, it shows a one-time message suggesting Install in Local. Dismiss permanently via the new `sshLite.suppressLocalInstallHint` setting.
- **New setting** — `sshLite.suppressLocalInstallHint` (boolean, default `false`).

**0.8.16** — **Donate: multi-token support** (docs-only — no extension code changes).

- SOL QR now accepts **SOL · USDT · USDC** — same Solana address receives any SPL token.
- TON QR now accepts **TON · USDT** — same TON address receives any Jetton.

[Full changelog](https://github.com/trantung95/SSHLite/blob/master/.adn/CHANGELOG.md)

## License

Apache-2.0

---

<div align="center">

### 🥖 Send me a Bánh Mì

#### If this extension saved you time, you could send me a Vietnamese sandwich! 🇻🇳

<sub>Scan the QR for whichever coin you want to send:</sub>

<table width="100%">
<tr>
<td align="center" valign="top" width="280">
  <img src="docs/images/donate/sol-qr.png" width="130" alt="SOL / USDT / USDC (Solana) QR"><br>
  <sub>send <b>SOL · USDT · USDC</b> — via Solana chain</sub><br>
  <sub><small>(any SPL token accepted)</small></sub><br>
  <sub><code>GURgJGXeFfbV9S4Kr1xgxCrS367w3gkCuuS8up7xiDEG</code></sub>
</td>
<td>&nbsp;</td>
<td align="center" valign="top" width="280">
  <img src="docs/images/donate/ton-qr.png" width="130" alt="TON / USDT (The Open Network) QR"><br>
  <sub>send <b>TON · USDT</b> — via The Open Network chain</sub><br>
  <sub><small>(any Jetton accepted)</small></sub><br>
  <sub><nobr><code>UQBbblS1-F3ufPBPD13EKfp28G_A_j10kXNn-XuuxQUwoIEs</code></nobr></sub>
</td>
</tr>
</table>

<sub>💡 No memo / tag required for either chain — just send the coin to the address.</sub>

<sub>⚠️ Send only the matching coin on its matching chain — wrong coin / wrong chain = lost funds</sub>

#### ☕ Made with cà phê sữa đá in Vietnam 🍜

</div>
