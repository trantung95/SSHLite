# Changelog

## v0.7.1 — Filter UX improvements

- `setFilenameFilter` now reads `sshLite.filterMaxResults` (was hardcoded 500); stores the limit in `ActiveFilter.maxResults`
- Success message always shows configured limit; messages >60 chars route to `vscode.window.showInformationMessage` popup instead of status bar
- Hit-limit warning popup with **Increase Limit** action (same pattern as deep filter) updates `filterMaxResults` globally
- `FilterResultsHeaderItem` accepts optional `limit` param; tooltip shows count vs. limit and flags when reached
- `FileTreeItem` accepts optional `filterLimit` param; tooltip shows per-folder match count and limit when a filter is active

## v0.7.0 — SSH Tools suite: process/service control, snippets, batch, keys, diff

Nine net-new utilities shipped as the next wave of the "SSH Tools" expansion. Overlap with existing `ServerMonitorService` (disk, network, basic process/service readouts) is intentionally left alone; this release adds **interactivity** where the monitor only showed data, and introduces fully new workflows for day-to-day SSH admin.

### New services
- **`SystemToolsService`**: interactive process listing + kill; systemd service list + start/stop/restart; hardened input validation (PID range, signal charset, unit-name regex)
- **`SnippetService`**: globalState-backed command library. Ships with 6 built-in snippets (disk usage, top CPU, top memory, listening ports, kernel/OS, uptime)
- **`SshKeyService`**: local `ssh-keygen` spawn + remote `authorized_keys` install (creates `~/.ssh` with mode 700, skips if key is already present, falls back to `/home/<user>` when `$HOME` resolves empty)
- **`RemoteDiffService`**: downloads a remote file to a temp path and opens it in VS Code's diff editor against a chosen local file
- **Virtual-doc providers** (`VirtualDocProviders.ts`): read-only `sshlite-env://` (environment inspector) and `sshlite-cron://` (crontab viewer) text-document content providers

### New commands (13)
- `sshLite.showRemoteProcesses` — ps table QuickPick → pick → kill (optionally with sudo)
- `sshLite.manageRemoteService` — systemctl units QuickPick → action picker (status/start/stop/restart)
- `sshLite.showRemoteEnv` — opens `env | sort` as a virtual read-only document
- `sshLite.editRemoteCron` + `sshLite.saveRemoteCron` — crontab viewer with explicit save-back flow (write to `/tmp/sshlite-cron-*.txt` → `crontab <file>` → delete temp)
- `sshLite.runSnippet`, `sshLite.addSnippet`, `sshLite.manageSnippets` — snippet library with rename/edit-command/delete actions
- `sshLite.batchRun` — multi-host QuickPick (≥2) + command prompt; runs in parallel via `Promise.allSettled`; output channel groups by `[host]`
- `sshLite.runLocalScriptRemote` — uploads a local script to `/tmp/sshlite-run-*`, chmod +x, executes, cleans up in `finally`
- `sshLite.generateSshKey` — wraps local `ssh-keygen` (ed25519 / rsa 3072/4096) with comment + passphrase prompts
- `sshLite.pushPubKeyToHost` — installs a local `.pub` file into the remote `~/.ssh/authorized_keys`
- `sshLite.diffWithLocal` — right-click a remote file → pick local file → VS Code diff editor

### Context-menu / command-palette placement
- Host context (`connectedServer`) gains a `5_tools` group: Processes, Services, Env, Cron, Run Snippet, Run Local Script, Push Pub Key
- File context (`file` viewItem) gains a `4_compare` group with "Diff with Local File"
- Batch Run, Add/Manage Snippets, Generate SSH Key, Save Crontab are palette-only
- All new commands use the "SSH Tools" category

### Modular command registration
- New `src/commands/` folder with feature-scoped handler files (`processAndServiceCommands.ts`, `envAndCronCommands.ts`, `snippetCommands.ts`, `batchAndScriptCommands.ts`, `keyCommands.ts`, `diffCommand.ts`) wired through a single `registerSshToolsCommands()` entry point from `extension.ts`

### Deferred
- **Jump Host / Bastion support** deferred to its own Phase 6 spec — requires ssh2 `sock` proxy chain, multi-hop key handling, and host-config UI changes

### Tests
- +30 tests: `SnippetService` (singleton, add/rename/update/remove, built-ins, invalid input), `SystemToolsService` (ps/systemctl parsers, kill input validation, service-name regex, sudo routing), `SshKeyService` (pushPublicKey variants — missing/empty/present/cached, `$HOME` fallback), `RemoteDiffService` (missing-local guard, temp-write + `vscode.diff` invocation)
- Full suite: **42 suites, 1252 passing** (was 1222 in v0.6.0)

### Audit
- `AuditAction` unchanged — new ops log via the existing `log()`/`logResult()` extension helpers, not the audit trail (they're ephemeral tool usage, not durable file mutations)

## v0.6.0 — SSH Tools rebrand + remote copy/paste

- **Rebrand to "SSH Lite (SSH Tools)"**: `displayName` updated in `package.json`, positioning the extension as a growing suite of SSH utilities rather than a narrow file browser. Marketplace keywords extended with `ssh tools`, `ssh utilities`, `ssh manager`, `ssh suite`, `remote tools`
- **Remote copy/paste**: right-click Copy/Cut on any remote file or folder, then right-click Paste on a destination folder or connection root. Also bound to `Ctrl+C` / `Ctrl+X` / `Ctrl+V` inside the file explorer view. Works on the same host (fast `cp -r`) and across different hosts (SFTP stream, recursive for folders). Multi-selection supported
- **Auto-rename on conflict**: pasting into a folder that already contains an entry with the same name produces `name (copy).ext`, `name (copy) 2.ext`, ...
- **Progress notification**: the paste flow shows a cancellable `withProgress` notification, listing the current item as `N/M`
- **Cut semantics**: on success, the SSH clipboard is cleared and both the source parent and destination folder are refreshed; cross-host cut uses copy + source delete
- **New services/methods**: `RemoteClipboardService` (singleton, in-memory, exposes `sshLite.hasClipboard` context key + `onDidChange`). `FileService.copyRemoteSameHost`, `moveRemoteSameHost`, `copyRemoteCrossHost`, `nextCopyName`, `resolveDefaultRemotePath`, `deleteRemotePath`
- **New commands**: `sshLite.copyRemoteItem`, `sshLite.cutRemoteItem`, `sshLite.pasteRemoteItem`, `sshLite.clearRemoteClipboard`
- **Audit trail**: new `copy` action type; cross-host audits record `localPath` as `destHost:destPath`
- **Tests**: +27 tests (RemoteClipboardService singleton/state/context-key/events; FileService copy-same-host quoting + audit, cross-host stream + folder recursion, `nextCopyName` edge cases). Full suite: 1222 passing

## v0.5.6 — PEM private key authentication via UI

- **Private key (PEM) credentials in Add User flow**: `sshLite.addCredential` now asks whether to authenticate with a password or a private key. PEM path validates the file exists/is readable, then asks for an optional passphrase (empty = passwordless key). Fixes [#3](https://github.com/trantung95/SSHLite/issues/3)
- **Auto-use configured `privateKeyPath` on first connect**: `sshLite.connectWithCredential` no longer forces a password prompt when the host already has an Identity File (e.g. from `~/.ssh/config`). Creates or reuses a `privateKey` credential instead (dedup by `privateKeyPath`)
- **Retry path for bad passphrase**: connection failures on a `privateKey` credential now surface a "Re-enter Passphrase" action, mirroring the existing password-retry flow
- **`CredentialService.addCredential` accepts empty secret**: skip writing to `SecretStorage` when the passphrase is empty so passwordless keys don't leave blank entries. `SSHConnection.buildAuthConfig` already gates passphrase auth on `getCredentialSecret` returning truthy

## v0.5.4 — VS Code-style search enhancements

- **Whole word search**: New `Ab|` toggle button (between `Aa` and `.*`) matches whole words only via grep `-w` flag. Works with both literal (`-F`) and regex modes. Content search only (not find-files mode). State saved per tab and restored on panel re-open
- **Comma-separated include patterns**: "Files to include" field now accepts `*.ts, *.js` — generates multiple `--include` flags for grep. `listEntries()` uses OR'ed `-name` clauses in find: `\( -name '*.ts' -o -name '*.js' \)`. Worker pool `listEntriesPattern` guard updated to allow commas
- **Default exclusions**: New `sshLite.searchUseDefaultExcludes` setting (default: `true`). Auto-excludes `.git, .svn, .hg, CVS, .DS_Store, node_modules, bower_components, *.code-search` — matching VS Code's `files.exclude` + `search.exclude` defaults. Prepended to user's exclude patterns in `performSearch()`

## v0.5.3 — Security hardening, race condition fixes, disconnect reconnecting servers

- **Command injection fix**: Backup exec commands now use single-quote escaping instead of double-quote wrapping, preventing shell injection via crafted file paths
- **SFTP race condition fix**: `getSFTP()` now serializes concurrent callers via a shared promise, preventing duplicate SFTP sessions
- **Disconnect reconnecting servers**: Servers stuck in "Waiting for reconnection..." now show a disconnect button. New `reconnectingServer` contextValue
- **Worker pool done signal fix**: `pendingDirListings` decremented before done check, fixing false `done: false` on empty directories
- **Port forward stream error handlers**: Added `stream.on('error')` and `socket.on('error')` handlers to `forwardPort()`
- **readFileTail retry**: Changed to `_execChannel()` with exponential backoff
- **FileService.dispose() cleanup**: Stops watch heartbeat, disposes all subscriptions and emitters
- **Connection listener leaks**: `HostTreeProvider` now stores and disposes its `onDidChangeConnections` listener
- **Deactivate cleanup**: `activityService.dispose()` and `portForwardService.dispose()` added to `deactivate()`
- **cleanupServerBackups fix**: `find -print -delete | wc -l` so deleted count is actually reported
- **Normalize getLocalFilePath()**: Return value now uses `normalizeLocalPath()`
- **buildServerSearchEntries fix**: Connected check now uses `c.host.id` instead of `c.id`
- **ReDoS prevention**: `highlightMatch` regex construction wrapped in try/catch
- **Duplicate ready handler removed**: SearchPanel no longer registers two `ready` message handlers
- **ServerMonitorService logging**: Replaced per-line `appendLine` in loops with collected array + single call
- **Dead code removed**: Deleted unused `SearchResultsProvider.ts` and its test file
- **fileChangeSubscriptions cleanup on disconnect**: Subscriptions disposed when heartbeat detects connection loss

## v0.5.1 — Tooltip improvements: add Created time, remove duplicate path

- **Created time**: Local file tooltips now show file creation time (`birthtimeMs`) between Size and Modified
- **Remove duplicate path**: Removed `Path:` line from local tooltips — VS Code already displays the path natively

## v0.5.0 — Local file tooltips in VS Code explorer

- **Local file tooltips**: Hovering files/folders in VS Code explorer shows tooltip with size, created, modified, accessed, permissions
- **SSH temp file tooltips**: Remote files in editor tabs show remote path, server, size, modified, owner:group, permissions
- **New setting `sshLite.localFileTooltips`**: Boolean (default: `true`). Controls both local and SSH remote file tooltips
- **Permission formatting**: Unix permission string from `stat.mode` bitmask, cross-platform

## v0.4.7 — Search priority throttling & concurrent search tabs

- **Lower default workers**: Default `searchParallelProcesses` reduced from 20 to **5**, minimum from 5 to **1**
- **Search priority throttling**: Active non-search operations auto-throttle search workers to **1**
- **Concurrent search tabs**: "Keep Results" keeps search running in parallel; workers divided equally among concurrent searches
- **Per-search state isolation**: Per-search tracking via `activeSearches: Map<searchId, {...}>`
- **Pool ownership tracking**: New `poolConnectionMap` and `searchPoolMap` for per-search cleanup
- **Stale search guard fix**: Changed to `!this.activeSearches.has(searchId)` check

## v0.4.6 — Fix missing search results, data correctness improvements

- **Channel retry on SSH exec**: `_execChannel()` with exponential backoff (5 retries, 200ms–3200ms) for "Channel open failure"
- **Worker pool stability**: `pendingDirListings` counter keeps workers alive until all directories expanded
- **UTF-8 chunk corruption fix**: Accumulate raw `Buffer` chunks, decode once via `Buffer.concat().toString('utf8')`
- **Binary file skipping**: Added `-I` flag to grep command
- **Symlink discovery**: `listEntries()` now uses `find -L`
- **Cancel message fix**: Closing kept tab sends correct `cancelSearch` message type

## v0.4.5 — Remove auto-excluded dirs, fix worker scaling

- **Removed auto-excluded system dirs**: Search no longer auto-excludes `/proc`, `/sys`, `/dev`, `/run`, `/snap`, `/lost+found`
- **Fixed worker pool scaling**: `desiredWorkerCount` set to full configured value; workers auto-spawn as queue grows

## v0.4.4 — Search panel redesign & filter improvements

- **Keep Results mid-search**: Pins tab with ongoing search, creates fresh Current tab
- **Isolated tab state**: Each kept tab owns its own query, options, results, expand state
- **searchBatch routing**: `tabSearchIdMap` routes results to correct kept tab
- **Dynamic worker adjustment**: Worker count changes take effect immediately mid-search
- **Filter mode graying**: Folder/both modes gray out non-matching items instead of hiding
- **Filter QuickPick fixes**: Mode options persist when typing; last selected mode remembered

## v0.4.3 — Improved port forward input UX

- Reordered prompt: server port → target host → local port
- Local port defaults to server port

## v0.4.2 — Persistent port forwarding (GitHub Issue #2)

- Port forwards auto-saved to globalState and auto-restored on reconnect/restart
- `ISavedPortForwardRule` type, `SavedForwardTreeItem` with play/delete actions
- PortForwardService persistence layer: `initialize()`, `saveRule()`, `deleteSavedRule()`, `restoreForwardsForConnection()`, `activateSavedForward()`

## v0.4.1 — Filter by name on server level, fix reconnect loop

## v0.4.0 — Project DNA documentation system

- `.adn/` documentation system: 18-file "project DNA"
- Self-sustaining growth playbooks, coding conventions, self-maintenance checklist

## v0.3.0

- Fix "Invalid username" connection failure, reconnect loop on invalid config
- Host config validation, improved connection logging
- Fix search multi-folder, sort by checked

## v0.2.5

- Remove User from hosts panel (saved + SSH config)
