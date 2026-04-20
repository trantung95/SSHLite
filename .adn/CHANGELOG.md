# Changelog

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
