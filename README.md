# SSH Lite (SSH Tools) — Lightweight SSH Suite for VS Code

![Version](https://img.shields.io/badge/version-0.8.6-blue)
![Status](https://img.shields.io/badge/status-beta-yellow)
![License](https://img.shields.io/badge/license-Apache--2.0-green)
![VS Code](https://img.shields.io/badge/VS%20Code-1.85.0+-purple)

> Active development. Please report issues on [GitHub](https://github.com/trantung95/SSHLite/issues).

**Lightweight SSH for VS Code.** Connect, browse files, open terminals, forward ports, manage processes & services, push SSH keys, run snippets and batch commands — all **without installing anything on the remote server**. Perfect for small VMs, shared hosting, and resource-constrained environments.

![SSH Lite Overview](docs/images/feature-overview.png)

## Why SSH Lite?

Unlike Remote-SSH, which installs a ~200MB VS Code Server on every host, SSH Lite runs entirely from your local VS Code.

| | SSH Lite | Remote-SSH |
|---|---|---|
| Remote install | **None** | ~200MB+ |
| Tiny VMs (512MB RAM) | ✓ | Often fails |
| Multiple connections | ✓ | Limited |
| Server resource usage | **Zero** | High |

## Features

- **File browser** — SFTP browse / edit / upload / download with tab badges (✓ ↑ ✗) for sync state
- **Multi-server search** — regex, whole word, include/exclude patterns, results grouped by server
- **Integrated terminals** — many per connection, no re-auth
- **Port forwarding** + **server monitor** (CPU / memory / disk / top processes)
- **Remote copy / paste** — `Ctrl+C` / `Ctrl+X` / `Ctrl+V` across hosts, auto-renames on conflict
- **SSH Tools suite** — process viewer, service manager, env inspector, cron editor, snippet library, batch runner, script runner, key manager (generate + push), remote diff

## Quick Start

1. Install — search "SSH Lite" in Extensions, or `code --install-extension hybr8.ssh-lite`
2. Click **+** in the SSH Lite sidebar, add a host
3. Click the host to connect — credentials are saved automatically

Reads `~/.ssh/config`. Supports SSH keys (RSA / Ed25519 / ECDSA, encrypted), agent, and password.

**98 commands** — full reference at [docs/COMMANDS.md](https://github.com/trantung95/SSHLite/blob/master/docs/COMMANDS.md).

## Release Notes

**0.8.6** — Fixed "search + click result + wait ~1 minute = crash" on wide queries against large servers. Two root causes: (1) every `searchBatch` message rebuilt every match-item in the webview DOM, even when the result set hadn't changed — at ~10 batches/s for 60s on a 12 000-result query, the webview's V8 heap exhausted; new cheap-render fast path skips the rebuild when count/scope/viewMode are unchanged and updates only the live progress counter. (2) Search workers kept dispatching dir listings after the result limit was hit, generating the empty batches that triggered the rebuilds; now `abortController.abort()` fires once when `globalSeen.size >= maxResults`, which `SSHConnection.searchFiles` translates into `SIGTERM` + channel close on remote grep processes. Also: file-watcher poll no longer re-downloads unchanged files (size+mtime fast path in `refreshSingleFile`), and polling pauses when the watched file isn't in any visible editor.

**0.8.5** — Fixed "Filter by Name" at the server-row level: filter is now applied at the live current path (was using a stale `currentPath` snapshot from construction), gray-out and color now work when basePath is `/` (decoration prefix was double-slashed), and the connection row description shows `[filter: pattern] (count)` while a filter is active, restoring the `user@host - path` server info when cleared.

**0.8.4** — Marketplace README rewrite. Listing trimmed from ~500 to ~66 lines (removed duplicate features list, usage section, command tables, keyword block, and old release notes). Fixed broken `/blob/main/` links to `/blob/master/`. Docs-only release — no code changes.

**0.8.3** — Search stability + stat-enrichment restored: event-loop yields throughout the search hot paths, global cap of 10 simultaneously-active workers, lower defaults for `searchParallelProcesses` (5 → 2, max 50 → 10).

[Full changelog](https://github.com/trantung95/SSHLite/blob/master/.adn/CHANGELOG.md)

## License

Apache-2.0

---

<div align="center">

### 🥖 Send me a Bánh Mì

<sub>If this extension saved you time, you could send me a Vietnamese sandwich! 🇻🇳</sub>

**Crypto wallet**: *Coming soon* ☕

<sub>🪷 Made with cà phê sữa đá in Vietnam 🍜</sub>

</div>
