# SSH Lite -- Lightweight VS Code SSH Extension

*Created by TungTran (Hybr8)*

VS Code extension for SSH file browsing, editing, terminals, and search — **without** installing a VS Code server on remote machines. Built with TypeScript, ssh2, and VS Code Extension API.

For detailed architecture, design decisions, and deep documentation see the `.adn/` folder.

---

## Quick Commands

```bash
npm run compile                          # Compile TypeScript
npm run watch                            # Watch mode
npx jest --no-coverage                   # Run all unit tests (1127 tests, ~13s)
npx jest -- HostTreeProvider             # Run specific file
npx jest --testPathPattern=docker        # Docker integration tests
npm run test:chaos                       # Chaos bug discovery (quick, 3-5 min)
npm run test:chaos:deep                  # Chaos bug discovery (deep, 10+ min)
npx vsce package                         # Create .vsix
```

---

## Project Structure

```
src/
  extension.ts                    # Main entry, commands, wiring
  types.ts                        # Core interfaces
  connection/
    ConnectionManager.ts          # Multi-connection, auto-reconnect
    SSHConnection.ts              # SSH/SFTP operations
  services/
    FileService.ts                # File ops, auto-sync, backups
    HostService.ts                # SSH config parsing
    CredentialService.ts          # Credentials + pinned folders
    TerminalService.ts            # SSH terminals
    PortForwardService.ts         # Port forwarding
    AuditService.ts               # Audit logging
    ActivityService.ts            # Activity tracking
    ServerMonitorService.ts       # Server diagnostics
    CommandGuard.ts               # Activity tracking middleware
    + FolderHistoryService, ProgressiveDownloadManager, PriorityQueueService
  providers/
    HostTreeProvider.ts           # SSH hosts tree
    FileTreeProvider.ts           # Remote files tree
    FileDecorationProvider.ts     # Badges (↑ ✗ M)
    ActivityTreeProvider.ts       # Activity panel
    PortForwardTreeProvider.ts    # Port forwards tree
  webviews/
    SearchPanel.ts                # Cross-server search
.adn/                             # Deep documentation (project DNA)
```

---

## LITE Principles (CRITICAL)

**LITE = Lightweight, Intentional, Transparent, Efficient**

**IMPORTANT: These rules apply to ALL prompts (agents, skills, regular chat).**

SSH Lite must be **LITE** - minimize server resources and UI complexity, but **never sacrifice data correctness**.

| Rule | Bad | Good |
|------|-----|------|
| No auto server commands | `find` on every keystroke | User clicks "Search" button |
| No polling by default | Auto-refresh enabled | User enables in settings |
| Cache aggressively | Preload 5 subdirs | Load on user expand |
| Single connection | Multiple SSH sessions | Reuse connection |
| Debounce actions | Immediate server call | 300ms+ debounce |
| True data, no missing | Timeout and skip slow dirs | Wait for all results |
| No auto-changing data | Auto-truncate/filter results | Show everything the user asked for |

**Before implementing, ask:**
- Does this run server commands automatically? → Make it user-triggered
- Does this poll the server? → Make it opt-in, default OFF
- Does this preload data? → Make it lazy-load on demand
- Could this lose or alter user data? → **Never** — LITE means lightweight, not lossy

---

## Performance First

**Analyze every request for the best performance and fastest approach.**

- Choose the most efficient algorithm/data structure for the job
- Avoid unnecessary iterations, allocations, or async overhead
- Prevent infinite loops: always add safety guards to `while` loops (e.g., `parent === p` break, max iteration count)
- Prefer lazy evaluation over eager computation
- Use caching to avoid redundant I/O or computation
- Profile before optimizing — measure, don't guess

---

## Code Quality

- Remove unused files/code - no dead code
- Use `log()` for output channel logging
- Don't log in loops - log summaries
- Keep source clean and consolidated
- Use `normalizeLocalPath()` for all local file path Map lookups
- Go through `CommandGuard` for significant SSH operations
- Use stable tree item `id` (never include dynamic state)

---

## Testing

- Run `npx jest --no-coverage` before committing
- Add tests for new functionality
- Use shared mocks from `src/__mocks__/testHelpers.ts`
- Reset singletons in `beforeEach`: `(Service as any)._instance = undefined`
- **Transpiler**: `@swc/jest` (not `ts-jest`) — 3-5x faster compilation
- **Mock hoisting rule**: `@swc/jest` does NOT hoist `const`/`let` into `jest.mock()` factories like `ts-jest` did. Use `var` for mock variables referenced inside `jest.mock()` factories, and use **getters** for properties that reference those vars (defers access to test runtime). Create singleton mock instances inside the factory with `mockReturnValue`, NOT `mockImplementation(() => ({...}))` which creates new objects per call and breaks event subscriptions.

---

## Documentation (.adn/)

The `.adn/` directory is the **project DNA** — it contains the authoritative documentation for this project. Any AI assistant or developer can fully understand, maintain, and extend SSH Lite from these docs.

**IMPORTANT: Keep `.adn/` in sync with code changes.**
After any code change that affects behaviour, architecture, or contracts, update the `.adn/` docs:

### When to update existing files

| Change type | Update these `.adn/` files |
|---|---|
| New/changed service | `architecture/overview.md`, `architecture/project-structure.md` |
| New/changed command | `configuration/commands-reference.md`, `architecture/project-structure.md` |
| New tree item type / contextValue | `features/tree-providers.md`, `configuration/commands-reference.md` |
| Settings added/removed/changed | `configuration/settings-reference.md` |
| Connection logic change | `features/connection-management.md`, `flow/connection-flow.md` |
| File operations change | `features/file-operations.md`, `flow/file-save-flow.md` |
| Search/filter change | `features/search-system.md`, `flow/search-flow.md` |
| Terminal/port forward change | `features/terminal-port-forwarding.md` |
| Activity/audit change | `features/activity-audit.md` |
| Tree provider/decoration change | `features/tree-providers.md` |
| Test pattern/infrastructure change | `testing/testing-strategy.md` |
| Chaos test/scenario change | `testing/chaos-testing.md`, `src/chaos/coverage-manifest.json` |
| Startup/activation flow change | `flow/extension-activation.md` |
| Type/interface change | `architecture/types-reference.md` |

### When to create new files / folders

If a change introduces a **new major concept or subsystem** that doesn't fit into an existing doc, create a new `.md` file under `.adn/`. Examples:

- Adding a new webview panel → create `.adn/features/my-panel.md`
- Adding a new integration type → create `.adn/features/my-integration.md`

**Guidelines for new `.adn/` files:**
- Place in the most relevant existing folder first; only create a new folder when none fits
- Follow the same markdown style as existing docs (headings, tables, code blocks)
- Update `.adn/README.md` to include the new file in the folder map

---

## Self-Sustaining Growth

This project is designed to grow itself. The `.adn/growth/` folder contains everything needed to extend SSH Lite consistently:

- **`.adn/growth/playbooks.md`** — Step-by-step recipes for adding commands, services, tree views, settings, decorations, webviews, and features
- **`.adn/growth/coding-conventions.md`** — Singleton, EventEmitter, debounce, path normalization, error handling, and naming patterns
- **`.adn/growth/self-maintenance.md`** — Post-change verification checklist, consistency rules, rename/remove procedures

### Workflow for Any Change

1. **Before coding**: Read the relevant playbook in `.adn/growth/playbooks.md`
2. **While coding**: Follow patterns in `.adn/growth/coding-conventions.md`
3. **After coding**: Run the checklist in `.adn/growth/self-maintenance.md`:
   - `npm run compile` — 0 errors
   - `npx jest --no-coverage` — all tests pass
   - Update `.adn/` docs (this file's mapping table above)
4. **If adding a major new concept**: Create new `.adn/` file, update `README.md` folder map

---

## Release Notes

### v0.5.4 — VS Code-style search enhancements

- **Whole word search**: New `Ab|` toggle button (between `Aa` and `.*`) matches whole words only via grep `-w` flag. Works with both literal (`-F`) and regex modes. Content search only (not find-files mode). State saved per tab and restored on panel re-open
- **Comma-separated include patterns**: "Files to include" field now accepts `*.ts, *.js` — generates multiple `--include` flags for grep. `listEntries()` uses OR'ed `-name` clauses in find: `\( -name '*.ts' -o -name '*.js' \)`. Worker pool `listEntriesPattern` guard updated to allow commas
- **Default exclusions**: New `sshLite.searchUseDefaultExcludes` setting (default: `true`). Auto-excludes `.git, .svn, .hg, CVS, .DS_Store, node_modules, bower_components, *.code-search` — matching VS Code's `files.exclude` + `search.exclude` defaults. Prepended to user's exclude patterns in `performSearch()`

### v0.5.3 — Security hardening, race condition fixes, disconnect reconnecting servers

- **Command injection fix**: Backup exec commands (`createServerBackup`, `restoreFromServerBackup`, `createDirectoryBackup`) now use single-quote escaping instead of double-quote wrapping, preventing shell injection via crafted file paths
- **SFTP race condition fix**: `getSFTP()` now serializes concurrent callers via a shared promise, preventing duplicate SFTP sessions when multiple operations trigger `getSFTP()` simultaneously
- **Disconnect reconnecting servers**: Servers stuck in "Waiting for reconnection..." now show a disconnect button. Clicking it stops the reconnect loop permanently. New `reconnectingServer` contextValue with spinning yellow icon
- **Worker pool done signal fix**: `pendingDirListings` is now decremented before the done check in search worker pools, fixing false `done: false` on empty directories. Non-worker-pool search tasks use simple `completedCount >= totalCount` check (no longer reference out-of-scope `isDone()`)
- **Port forward stream error handlers**: Added `stream.on('error')` and `socket.on('error')` handlers to `forwardPort()`, preventing unhandled errors from crashing the extension when either side drops
- **readFileTail retry**: Changed from raw `this._client.exec()` to `this._execChannel()` with exponential backoff, fixing "Channel open failure" under concurrent load
- **FileService.dispose() cleanup**: Now stops watch heartbeat, disposes all `fileChangeSubscriptions`, and disposes `_onWatchedFileChanged`/`_onOpenFilesChanged`/`_onFileLoadingChanged` emitters
- **Connection listener leaks**: `HostTreeProvider` now stores and disposes its `onDidChangeConnections` listener. Three `connectionManager` listeners in `extension.ts` pushed to `context.subscriptions`
- **Deactivate cleanup**: `activityService.dispose()` and `portForwardService.dispose()` added to `deactivate()`
- **cleanupServerBackups fix**: Changed from `find -delete; find | wc -l` (always 0) to `find -print -delete | wc -l` so deleted count is actually reported
- **Normalize getLocalFilePath()**: Return value now uses `normalizeLocalPath()` for consistent Map lookups on Windows
- **buildServerSearchEntries fix**: Connected check now uses `c.host.id` instead of `c.id` to match host config IDs correctly
- **ReDoS prevention**: `highlightMatch` regex construction wrapped in try/catch — invalid patterns fall back to plain text instead of crashing
- **Duplicate ready handler removed**: SearchPanel no longer registers two `ready` message handlers
- **ServerMonitorService logging**: Replaced per-line `appendLine` in loops with collected array + single `appendLine` call
- **Dead code removed**: Deleted unused `SearchResultsProvider.ts` and its test file. Removed duplicate `formatTimeAgo` (uses shared `formatRelativeTime`)
- **fileChangeSubscriptions cleanup on disconnect**: Subscriptions are now disposed when heartbeat detects connection loss

### v0.5.1 — Tooltip improvements: add Created time, remove duplicate path

- **Created time**: Local file tooltips now show file creation time (`birthtimeMs`) between Size and Modified
- **Remove duplicate path**: Removed `Path:` line from local tooltips — VS Code already displays the path natively, so it was shown twice

### v0.5.0 — Local file tooltips in VS Code explorer

- **Local file tooltips**: Hovering any file or folder in VS Code's default file explorer now shows a tooltip with file metadata: size, created time, modified time, accessed time, and permissions. Uses `fs.statSync()` for instant local file stats. Directories show "Directory" instead of size. Path is omitted (VS Code already shows it natively).
- **SSH temp file tooltips**: Hovering SSH remote files opened in editor tabs now shows remote server info: remote path, server (host:port:user), size, modified, accessed, owner:group, and permissions. Tooltip is appended to existing upload/connection status messages.
- **New setting `sshLite.localFileTooltips`**: Boolean (default: `true`). Controls both local and SSH remote file tooltips. When disabled, only badge decorations (upload ↑, failed ✗) remain.
- **Permission formatting**: Unix permission string (`rwxr-xr-x`) derived from `stat.mode` bitmask. Works cross-platform — Windows shows simplified permissions.

### v0.4.7 — Search priority throttling & concurrent search tabs

- **Lower default workers**: Default `searchParallelProcesses` reduced from 20 to **5**, minimum from 5 to **1**. Search is now lighter on server resources out of the box.
- **Search priority throttling**: When the user has active non-search operations (file browsing, uploads, downloads, terminals, monitoring, connecting) on a connection, search workers on that connection are auto-throttled to **1**. Workers restore to full count when user operations complete. Implemented via `ActivityService.onDidChangeActivities` subscription.
- **Concurrent search tabs**: "Keep Results" on an actively searching tab now keeps that search running in parallel. Starting a new search no longer aborts kept searches. Workers are divided equally among concurrent searches on the same connection (`ceil(fullWorkerCount / searchCount)`, min 1). When a search finishes, remaining searches get the full worker allocation back.
- **Per-search state isolation**: Replaced shared instance variables (`searchAbortController`, `currentSearchActivityIds`, counters) with per-search tracking via `activeSearches: Map<searchId, { abortController, activityIds, kept }>`. Counters (`completedCount`, `totalCount`, `globalSeen`) are now local variables in `performSearch()`.
- **Pool ownership tracking**: New `poolConnectionMap` and `searchPoolMap` track which connection and search owns each worker pool. Cleanup is per-search — completing or cancelling one search only removes its own pools, not other searches' pools.
- **Stale search guard fix**: Changed `searchId !== this.currentSearchId` to `!this.activeSearches.has(searchId)` throughout, so older concurrent searches don't falsely reject their own results.

### v0.4.6 — Fix missing search results, data correctness improvements

- **Channel retry on SSH exec**: Added `_execChannel()` helper with exponential backoff (5 retries, 200ms–3200ms) for "Channel open failure" errors. SSH servers limit concurrent channels (`MaxSessions`, often 10) — with many parallel workers, excess channels were rejected and those file batches permanently lost. Both `exec()` and `searchFiles()` now retry automatically, ensuring no results are dropped.
- **Worker pool stability (`pendingDirListings`)**: Workers no longer exit prematurely when the work queue is temporarily empty but directory listings are still in-flight. A `pendingDirListings` counter keeps workers alive until all discovered directories are fully expanded.
- **UTF-8 chunk corruption fix**: `exec()` and `searchFiles()` now accumulate raw `Buffer` chunks and decode once via `Buffer.concat().toString('utf8')`, preventing multi-byte character corruption at chunk boundaries.
- **Binary file skipping**: Added `-I` flag to grep command — binary files are skipped instead of producing garbage matches.
- **Symlink discovery**: `listEntries()` now uses `find -L` to follow symlinks, so symlinked directories and files are discovered during search.
- **Cancel message fix**: Closing a kept tab now sends the correct `cancelSearch` message type (was `cancel`), properly cancelling the server-side search.

### v0.4.5 — Remove auto-excluded dirs, fix worker scaling

- **Removed auto-excluded system dirs**: Search no longer auto-excludes `/proc`, `/sys`, `/dev`, `/run`, `/snap`, `/lost+found` when searching from root `/`. Removed the `searchExcludeSystemDirs` setting, the "Include all" UI notice, and the `searchExcludedSystemDirs` method.
- **Fixed worker pool scaling**: Workers were capped to the initial queue size (e.g., 1 when searching from `/`) instead of the configured count. Now `desiredWorkerCount` is set to the full configured value and workers auto-spawn as the queue grows from directory discovery.

### v0.4.4 — Search panel redesign & filter improvements

- **Keep Results mid-search**: Clicking "Keep Results" during an active search now pins the tab with its ongoing search — results keep streaming into the kept tab while a fresh Current tab is created
- **Isolated tab state**: Each kept tab owns its own query, options, results, expand state, and searching status with full save/restore on tab switch
- **searchBatch routing**: `tabSearchIdMap` routes progressive search results to the correct kept tab by searchId
- **LITE tab cleanup**: Closing a kept tab cancels its server-side search and frees all memory
- **Dynamic worker adjustment**: Changing per-server worker count mid-search takes effect immediately — workers spawn or self-terminate via `activeWorkerPools` registry
- **Filter mode graying**: Folder/both filter modes now gray out non-matching items instead of hiding them, matching the file filter visual behavior
- **Filter QuickPick fixes**: Mode options no longer disappear when typing; last selected mode is remembered across invocations; selection no longer resets to first item on keystroke

### v0.4.3 — Improved port forward input UX

- **Reordered port forward prompt**: Now asks server port → target host → local port (was local → remote host → remote)
- **Clearer prompt wording**: "Server port to forward", "Target host (localhost = SSH server itself)", "Listen on local port"
- **Local port defaults to server port**: Reduces input steps for the common case

### v0.4.2 — Persistent port forwarding (GitHub Issue #2)

- **Saved port forward rules**: Port forwards are auto-saved to globalState and auto-restored on reconnect or VSCode restart
- **New `ISavedPortForwardRule` type**: Persistence model for saved rules, scoped per-host
- **`SavedForwardTreeItem`**: Dimmed tree items for saved-but-inactive rules with play/delete inline actions
- **New commands**: `sshLite.activateSavedForward` and `sshLite.deleteSavedForward`
- **PortForwardService persistence layer**: `initialize()`, `saveRule()`, `deleteSavedRule()`, `restoreForwardsForConnection()`, `deactivateAllForwardsForConnection()`, `activateSavedForward()`
- **Integration tests**: 7 cross-service flows covering full lifecycle, multi-server isolation, partial restore failure
- **Per-function test matrix**: Comprehensive test documentation in `.adn/testing/testing-strategy.md`

### v0.4.1 — Filter by name on server level, fix reconnect loop

### v0.4.0 — Project DNA documentation system

- **`.adn/` documentation system**: 18-file "project DNA" covering architecture, features, flows, configuration, testing, and growth playbooks
- **CLAUDE.md rewrite**: Entry point with mapping table linking code changes to documentation files
- **Self-sustaining growth**: Playbooks for adding commands, services, tree views, settings, webviews, and features
- **Coding conventions**: Documented singleton, EventEmitter, debounce, path normalization, and error handling patterns
- **Self-maintenance**: Post-change verification checklist, consistency rules, rename/remove procedures
- **Retired `.claude-workflow.md`**: All content migrated into `.adn/` files

### v0.3.0

- Fix "Invalid username" connection failure, reconnect loop on invalid config
- Host config validation, improved connection logging
- Fix search multi-folder, sort by checked

### v0.2.5

- Remove User from hosts panel (saved + SSH config)

---

## Weekly Chaos Test Review

AI should review and enhance the chaos bug-discovery module weekly:
1. Run `npm run test:chaos:deep` and analyze all output
2. Read `logs/chaos-results.jsonl` for trends and new anomalies
3. Follow the full checklist in `.adn/testing/chaos-testing.md`
4. Enhance: scenarios, detection rules, invariants, and discovery strategies
5. Commit all improvements directly

## Chaos Test Catchup Rule

After any prompt that changes project logic (new methods, changed APIs, new services),
run `npm run test:chaos` to verify the chaos module detects the change.
If `coverage.methods_uncovered` reports new methods, add scenarios before committing.
