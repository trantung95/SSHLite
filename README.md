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

**108 commands** — full reference at [docs/COMMANDS.md](https://github.com/trantung95/SSHLite/blob/master/docs/COMMANDS.md).

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

**0.9.3** - **The coder types what you type into AI**: AI input hooks make the Support-view pixel coder fly the actual words you send to your AI assistants - plus a settings gear and crisper key popups.

- **AI input hooks (auto-set-up)** - the first time you open the Support view, SSH Lite adds a tiny *prompt-submit* hook to the AI tools you already have (Claude Code, Codex, Gemini, Cursor, Copilot), so when you send a prompt the coder flies the real characters you typed. Manage or remove it from the gear ⚙ panel; turn auto-setup off with `sshLite.npcAutoSetupHooks`.
- **Safe by construction** - hooks are written to each tool's own config with an append-only merge (your existing config and hooks are preserved), a backup, and atomic writes; a config it can't safely parse is left untouched. Nothing leaves your machine - the hook just nudges a tiny local file SSH Lite watches, so it never reads your AI transcripts.
- **Heads-up on the Claude Code VS Code extension** - it doesn't run hooks (an Anthropic limitation); hooks fire for Claude Code in a terminal, the Codex/Gemini CLIs, Cursor, and Copilot. The coder still reacts to the Claude extension when it produces output.
- **Settings gear + livelier coder** - a ⚙ button opens a settings panel (react-to-other-windows + hook controls); the coder flies the exact characters you type (Tab/Ctrl/Alt included in-panel), wakes when the window regains focus, and occasionally glances to the side.

**0.9.2** - **Terminal that feels native**: SSH Lite terminals now run remote shell plugins and TUI apps with the same colors and glyphs you'd get opening a terminal directly on the server.

- **fzf-tab and friends just work** - the terminal advertises `xterm-256color` (instead of the bare `vt100` default), so fuzzy tab-completion (fzf-tab), prompts (powerlevel10k, starship), and full-screen apps (vim, tmux, htop, lazygit, ranger) render in full color with correct box-drawing.
- **Locale forwarded like real `ssh`** - your `LANG` / `LC_*` and `COLORTERM` are sent to new terminals (mirroring OpenSSH's `SendEnv`), so UTF-8 powerline / nerd-font glyphs show correctly. The remote server must allow them via `AcceptEnv` (most do by default).
- **Configurable, backward-compatible, LITE** - tune `sshLite.terminal.termType`, `sshLite.terminal.forwardEnv`, and `sshLite.terminal.env`; applied once when the terminal opens (no polling, no extra server commands). This is native shell completion, not an extension keylogger - SSH Lite never intercepts your keystrokes.

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
