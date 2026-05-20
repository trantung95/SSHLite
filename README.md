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

## Release Notes

**0.8.16** — **Donate: multi-token support** (docs-only — no extension code changes).

- SOL QR now accepts **SOL · USDT · USDC** — same Solana address receives any SPL token.
- TON QR now accepts **TON · USDT** — same TON address receives any Jetton.

**0.8.15** — **Save-as-root redesign** (correctness + security bug fix + new commands).

- **Critical bug fixed** — the previous sudo-fallback wrote your sudo password into the saved file's first line when sudo was `NOPASSWD`-configured or had a warm credential cache. Files like `/etc/nginx/nginx.conf` and `/etc/hosts` could silently get corrupted with your password as their first line, and that password ended up on disk on the remote host. The new `_sudoExecRaw` protocol writes the password only when sudo actually prompts (stderr-sync state machine, modelled on `yy0931/save-as-root`).
- **New: `Save File as Root`** — manually elevate the active editor's save without having to let SFTP fail first.
- **New: `Save File as User…`** — save as any specific user (e.g. `www-data`, `postgres`) via `sudo -u`.
- **New: `New File as Root…`** — right-click a folder (or connection) in REMOTE FILES → creates the file with root ownership in one step.
- **All sudo paths (write/read/delete/mkdir/rename/list/exec)** now share the fixed protocol; existing auto-fallback dialog ("Sudo Once / Sudo All / Cancel") works the same but no longer leaks the password.

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
