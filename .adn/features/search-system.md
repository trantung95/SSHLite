# Search System

Cross-server search via `SearchPanel` webview: server checkboxes, auto-connect/disconnect, redundancy detection, find-files mode.

## Architecture

```
SearchPanel (TS, extension) ←postMessage/onMessage→ Webview (HTML/JS, browser)
```

**Extension → Webview**: `updateState`, `searching`, `searchBatch` (progressive results), `updateServerConnection`
**Webview → Extension**: `search`, `toggleServer`, `openResult`, `cancelSearch`, `keepSearch`, `removeServerPath`, `setServerMaxProcesses`

## Server List Management

Each `ServerSearchEntry`: `id`, `hostConfig`, `credential`, `connected`, `checked`, `disabled`, `searchPaths[]`, `maxSearchProcesses?`.

Key APIs: `setServerList()`, `addScope()`, `removeServerPath()`, `toggleServer()`, `updateServerConnection()`.

### Redundancy Detection

Same-user child paths are grayed out and skipped (e.g., `/` covers `/home/user`). Uses `isChildPath()` with root `/` handling. Implicit root: adding path to checked server with no paths auto-inserts `/` first.

## Search Execution

### Search Options (VS Code-style)

| Toggle | Grep Flag | Description |
|--------|-----------|-------------|
| `Aa` Match Case | `-i` (off) | Case-sensitive |
| `Ab\|` Whole Word | `-w` | Word boundary (content only) |
| `.*` Regex | `-F` (off) | Regex vs literal |
| `📄` Find Files | — | `find` instead of `grep` |

Comma-separated include patterns (e.g., `*.ts, *.js`) → multiple `--include` flags. Default exclusions (`searchUseDefaultExcludes`): `.git, node_modules, .svn`, etc.

### Content Search (grep)

Build grep: `grep -rnHI [-F] [-w] [-i] --include=... --exclude-dir=... -- '<query>' <paths>`. Execute via `SSHConnection.searchFiles()`. Parse `filepath:linenum:content`. Progressive `searchBatch` delivery. Stop at `searchMaxResults`.

**Data correctness**: `Buffer.concat()` for UTF-8 safety. **Channel retry**: `_execChannel()` with exponential backoff (5 retries, 200ms–3200ms) for "Channel open failure".

### Find Files Mode

`find <paths> <typeFlag> -iname "<pattern>"` with `typeFlag`: `-type f`, `-type d`, or both. Progressive results via `searchBatch`.

### Progressive Results (searchBatch)

Incremental delivery per task completion. Cross-batch dedup via `globalSeen` set. Webview debounces re-renders (100ms) with scroll preservation. Progress header: `"42 results in 8 files (3/7 done...)"`.

### Parallel Search (Worker Pool)

For large directories, file-level worker pool balances load:

1. Seed queue with root dir → worker lists entries → batch files by 32KB path size → add subdirs to queue
2. Workers pick from shared queue: grep file batches or list more dirs
3. Each batch sends `searchBatch` progressively

**Properties**: Zero duplication, zero missed files, perfect load balance. `find -L` follows symlinks. Fallback: `grep -r` if `listEntries()` fails. `pendingDirListings` counter prevents premature worker exit.

Skip pool when: `parallelProcesses === 1` or path is a file.

### Auto-Connect / Auto-Disconnect

Search start: disconnected servers with credentials auto-connect. Search end: auto-connected servers with 0 results auto-disconnect; servers with results stay connected.

### Search Cancellation

New search only cancels un-kept searches. Cancel sends SIGTERM to remote processes. Both `.then()` and `.catch()` check `signal.aborted` to prevent stale messages.

## Per-Server Search Processes

Inline "Workers" control per server, persisted in `globalState` (`sshLite.serverSearchSettings`). Clamped 1–50. `null` = global default.

### Dynamic Worker Adjustment (Mid-Search)

`activeWorkerPools` Map tracks pools. On change: find pools for server → update `fullWorkerCount` → `_updateSearchPriority()` recalculates `desiredWorkerCount` (accounting for throttling + multi-search). Workers self-terminate when `activeWorkerCount > desiredWorkerCount` (min 1). Pool cleanup is per-search.

## Concurrent Searches (searchId)

Monotonic `currentSearchId` counter. `activeSearches: Map<searchId, { abortController, activityIds, kept }>`. Only un-kept searches aborted on new search. All messages guarded by `signal.aborted || !activeSearches.has(searchId)`. Counters are local to `performSearch()`.

## Keep Results (Tab Bar)

Pin search results as tabs (session-only, max 10). Each tab: isolated state (query, options, results, expand state, searchId, searching).

**Pin flow**: Save current state → move to `resultTabs` → register `tabSearchIdMap[searchId] = tabId` → send `keepSearch` → create fresh current tab. Kept searches continue, workers redistributed.

**Tab switch**: `saveCurrentInputState()` → `restoreTabState()` → update search/cancel visibility.

**searchBatch routing**: Check `tabSearchIdMap[searchId]` → append to kept tab → if active tab re-render, else update count. On `done`, remove routing.

**Tab close (LITE)**: Cancel active search → remove routing → free memory → switch to Current tab.

## Search Priority Throttling

`_setupSearchPriorityThrottling()` subscribes to `ActivityService.onDidChangeActivities`:
1. Divide `fullWorkerCount` by concurrent search count per connection (ceil, min 1)
2. If user has active non-search ops (`download`, `upload`, `directory-load`, `file-refresh`, `terminal`, `monitor`, `connect`) → force 1 worker
3. Workers self-terminate when over limit

Throttle listener created on first search, disposed when all searches complete.

## Sort Order

Toggle checked-first vs alphabetical. Persisted in `globalState` (`sshLite.searchSortOrder`).
