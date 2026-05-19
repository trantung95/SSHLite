# SSH Lite (SSH Tools) — Lightweight SSH Suite for VS Code

![Version](https://img.shields.io/badge/version-0.8.11-blue)
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

**0.8.11** — **Activation hardening — hotfix for v0.8.10 crash.** Fixes a regression where all 4 SSH Lite tree views ("SSH HOSTS", "REMOTE FILES", "ACTIVITY", "PORT FORWARDS") failed to register with *"There is no data provider registered"*. Root cause: an unguarded throw in one service init step aborted the whole `activate()` function before it could reach `createTreeView()`. Each init step (`credential-svc`, `global-state`, `connection-mgr`, `port-forward-svc`, `folder-history-svc`, `snippet-svc`) and each `createTreeView` call is now wrapped in a `safeStep()` helper — a single failure logs to the SSH Lite output channel via `lifecycle / activate/*-failed` and the OTHER tree views still register. A summary `showErrorMessage` lists which step(s) failed so you know which feature is degraded; the rest of the extension keeps working. New Jest smoke test (`src/extension.activate.test.ts`) is the regression net: it asserts all 4 trees register on the happy path AND still register when one service init throws. **Lost hosts? Don't re-add yet.** Saved hosts are stored in your VS Code User `settings.json` under the key `sshLite.hosts` — they were never deleted, just unreadable because the extension never activated. Open `settings.json` (Cmd/Ctrl+Shift+P → "Preferences: Open User Settings (JSON)") and check the `sshLite.hosts` array — your data should still be there. If activation still has problems, open Output → SSH Lite for the per-step log and please file a bug with that log.

**0.8.10** — Donate section: **money-critical hotfix for v0.8.9 TON address** + simplified to 2 coins. (1) The TON address shipped in v0.8.9 read `UQBb**bI**S1-…` (uppercase `I` at position 6) but the actual wallet QR encodes `UQBb**bl**S1-…` (lowercase `l`) — verified by `jsqr` decoding the source-screenshot QR. Any TON donations made via the v0.8.9 README would have been sent to a different valid TON address (irrecoverable). Fixed in README, generator script, CHANGELOG, and the regenerated `ton-qr.png`. (2) Removed USDT and BNB QRs (kept only SOL + TON per request); table now uses `width="100%"` so the two QRs slide to opposite edges as the window widens (better camera isolation); TON address wrapped in `<nobr>` so it doesn't break at hyphens; added a "💡 no memo / tag required" info note. New `.adn/lessons.md` entry documents the verification-by-tautology mistake that caused the original bug (decoding our own generated QR proves the round-trip, not that the source matches).

**0.8.9** — Donate section overhaul. Replaced the placeholder with a 2×2 grid of branded QR codes accepting **USDT** (Solana SPL), **SOL**, **BNB** (BNB Smart Chain), and **TON**. Each QR has its coin's logo overlaid at center (error-correction level H, ≤20% obstruction so they still scan), generated by the new [scripts/generate-donate-qr.js](scripts/generate-donate-qr.js) and machine-verified — every QR decodes back to its source address via `jsqr`. The grid uses an explicit spacer column/row + a thin gray `+` divider so phone cameras can lock onto one finder pattern at a time without picking up the neighbouring QR. Logos sourced from `spothq/cryptocurrency-icons` (BSD-3-Clause) and `trustwallet/assets` (MIT). Docs-only release — no extension code changes.

**0.8.8** — Inline icon order is now visually consistent across every row in the file-explorer tree. `searchInScope` always sits at `inline@1`; `filterFileNames` / `clearFilenameFilter` at `inline@2` (where filter is applicable: folder + connection rows). Row-specific actions follow at `inline@3+` (file rows: `openFile`; folder rows: terminal + refresh; connection rows: disconnect + terminal + monitor). v0.8.7 made search-before-filter consistent within each row but left the absolute slot inconsistent — search was at slot 4 on connection rows but slot 1/2 on folder/file rows. v0.8.8 fixes the slot drift. Adds an "Tree Inline Icon Order" rule to `CLAUDE.md` so future menu edits don't reintroduce the same drift.

**0.8.7** — UI consistency fix for the search icon. Across the file-explorer tree, the inline `$(search)` icon now sits in the same relative slot for every item type (file, folder, connection) — right after the primary open/quick actions and before the filter icon. In the right-click context menu, "Search Here" is now consistently the second item under both files and folders (was buried mid-list for folders and silently overlapping with "Show Server Backups" for files, which masked the entry on some VS Code builds). No new commands.

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

#### If this extension saved you time, you could send me a Vietnamese sandwich! 🇻🇳

<sub>Scan the QR for whichever coin you want to send:</sub>

<table width="100%">
<tr>
<td align="center" valign="top" width="280">
  <img src="docs/images/donate/sol-qr.png" width="130" alt="SOL (Solana) QR"><br>
  <sub>send <b>SOL</b> — via Solana chain</sub><br>
  <sub><code>GURgJGXeFfbV9S4Kr1xgxCrS367w3gkCuuS8up7xiDEG</code></sub>
</td>
<td>&nbsp;</td>
<td align="center" valign="top" width="280">
  <img src="docs/images/donate/ton-qr.png" width="130" alt="TON (The Open Network) QR"><br>
  <sub>send <b>TON</b> — via The Open Network chain</sub><br>
  <sub><nobr><code>UQBbblS1-F3ufPBPD13EKfp28G_A_j10kXNn-XuuxQUwoIEs</code></nobr></sub>
</td>
</tr>
</table>

<sub>💡 No memo / tag required for either chain — just send the coin to the address.</sub>

<sub>⚠️ Send only the matching coin on its matching chain — wrong coin / wrong chain = lost funds</sub>

#### ☕ Made with cà phê sữa đá in Vietnam 🍜

</div>
