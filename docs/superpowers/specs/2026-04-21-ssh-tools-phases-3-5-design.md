# SSH Tools Phases 3–5: Utility Expansion Design

Date: 2026-04-21
Status: Approved — auto-implementing
Version target: **v0.7.0**

## Overview

After the v0.6.0 rebrand to "SSH Lite (SSH Tools)" and remote copy/paste, this spec adds 9 net-new utilities that turn the extension into a broader SSH tools suite. Phase 3–5 features from the original roadmap that already exist in `ServerMonitorService` (disk usage, network inspector, basic process/service/log output) are **not reimplemented** — we extend them with interactive actions where useful.

Out of scope: **Jump Host / Bastion support** (requires ssh2 `sock` proxy chain + host-config UI; deserves its own design session and becomes a separate Phase 6 spec).

## Deliverables — 9 features

All features follow LITE principles: user-triggered, no polling, no preloading, single connection reuse.

### 1. Interactive Process Kill (`sshLite.killRemoteProcess`)
- Reads `ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -100`
- Presents QuickPick with each process
- On select, confirms and runs `kill <pid>` (with sudo fallback)
- Surfaced in the host context menu next to the existing monitor action

### 2. Service Manager Actions (`sshLite.manageRemoteService`)
- Reads `systemctl list-units --type=service --no-pager --plain --state=loaded`
- QuickPick of services → action QuickPick (Status / Start / Stop / Restart)
- Runs the chosen `systemctl` subcommand with sudo fallback
- Output displayed via existing `ServerMonitorService.outputChannel`

### 3. Env Inspector (`sshLite.showRemoteEnv`)
- Runs `env | sort`
- Displayed as a virtual read-only document (one line per var)

### 4. Tail -f Log Viewer (`sshLite.tailRemoteLog`)
- Right-click a file in the tree (or command with path prompt) → opens a virtual read-only document
- Reads file with `tail -n 500 -F <path>` via an SSH exec channel
- Appended lines stream into the buffer via a `TextDocumentContentProvider`
- Stops on document close

### 5. Snippet Library (`sshLite.runSnippet`, `sshLite.addSnippet`, `sshLite.manageSnippets`)
- New `SnippetService` singleton backed by `globalState`
- Ships with 6 built-in snippets: disk usage, top CPU, top mem, listening ports, kernel, uptime
- `runSnippet` → pick connection → pick snippet → exec and show output
- `addSnippet` → prompt name + command → save
- `manageSnippets` → QuickPick with Delete / Rename per item

### 6. Batch Command Runner (`sshLite.batchRun`)
- Multi-select QuickPick of active connections (≥2)
- Prompt for a command
- Runs in parallel via `Promise.allSettled`
- Output channel shows `[host]` prefix per line, per connection

### 7. Remote Script Runner (`sshLite.runLocalScriptRemote`)
- File picker for a local `.sh` / `.py` / executable
- Uploads to `/tmp/sshlite-run-<uuid>.<ext>` via SFTP `writeFile`
- `chmod +x`, runs it, removes the temp file in `finally`
- Output shown in the status-bar / output channel

### 8. SSH Key Manager (`sshLite.generateSshKey`, `sshLite.pushPubKeyToHost`)
- `generateSshKey`: spawns local `ssh-keygen` with user-selected type (ed25519 default / rsa) + optional passphrase + destination file
- `pushPubKeyToHost`: pick a local `.pub` file → pick a connected host → append to `~/.ssh/authorized_keys` (creates dir with mode 700, file with mode 600 as needed)

### 9. Remote Diff (`sshLite.diffWithLocal`)
- Right-click remote file → prompts for a local file path (or file picker)
- Downloads remote to a temp file → opens VS Code's `vscode.diff` editor (local ↔ remote)

### 10. Cron Editor (`sshLite.editRemoteCron`)
- Reads `crontab -l 2>/dev/null || true` → opens as a virtual document (scheme `sshlite-cron`)
- On save, writes back via `echo <contents> | crontab -`
- Warns before overwriting if crontab changed on remote since open

## New Services / Providers

| Module | Purpose |
| --- | --- |
| `SnippetService` | globalState-backed snippet storage + built-ins |
| `SystemToolsService` | Wraps interactive process kill + service manager (delegates to `ServerMonitorService` for display) |
| `SshKeyService` | Key generation (local) + pub-key push |
| `RemoteDiffService` | Download-to-temp + open diff editor |
| `RemoteCronDocumentProvider` | Virtual document for `sshlite-cron:` URIs |
| `RemoteTailDocumentProvider` | Virtual document for `sshlite-tail:` URIs, streams via SSH exec |
| `RemoteEnvDocumentProvider` | Virtual read-only document for `sshlite-env:` URIs |

## Testing

One `.test.ts` per new service covering:
- Singleton behavior
- Built-in snippet presence; add/delete/rename
- Pub-key push path (mocked connection, `writeFile` + `mkdir` invocations verified)
- Diff flow: temp file written, `vscode.diff` called
- Cron provider returns crontab output; triggers write on save
- Process kill / service manager input paths (mocked QuickPick)

Full suite target: **1275+** tests passing.

## package.json

- Register all 12 new commands in `contributes.commands`
- Add context-menu entries (monitor group) for process/service/env
- Add tree-context entries for tail and diff on `file` viewItems
- Version bump `0.6.0 → 0.7.0`
- No new dependencies

## Documentation

- `.adn/CHANGELOG.md` — v0.7.0 entry
- `.adn/configuration/commands-reference.md` — 12 new commands
- `.adn/architecture/overview.md` + `project-structure.md` — new services
- `.adn/features/` — new `ssh-tools-utilities.md`

## Risk / Rollback

- All features are additive; no existing APIs changed
- `AuditAction` gains `'exec-snippet'` for audit trail
- No new external deps
- Rollback: revert commands + services + package.json
