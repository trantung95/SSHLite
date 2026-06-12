# Search System

Cross-server search via `SearchPanel` webview: server checkboxes, auto-connect/disconnect, redundancy detection, find-files mode.

## Architecture

```
SearchPanel (TS, extension) ←postMessage/onMessage→ Webview (bundled from webview-src/search/)
                                                     │
                                                     ├─ index.ts    (bootstrap + runtime; phase-2 split coming)
                                                     ├─ log.ts      (postMessage-based logger)
                                                     ├─ styles.css  (lifted from old inline <style>)
                                                     └─ index.html  (HTML skeleton; URIs + nonce injected at load)
```

**Extension → Webview**: `updateState`, `searching`, `searchBatch` (progressive results), `updateServerConnection`
**Webview → Extension**: `search`, `toggleServer`, `openResult`, `cancelSearch`, `keepSearch`, `removeServerPath`, `setServerMaxProcesses`

### Logging

All search webview events land in the single **SSH Lite** Output channel:

- Extension side: `infoLog('search-panel', ...)` for show/dispose/webview-error; `diagLog('search-panel', ...)` for every `post`/`recv`.
- Webview side: posts `{type:'log', level, scope, event, payload}` back to the extension via the `log.ts` helper. The extension forwards via `infoLog`/`diagLog`.
- Triage: enable `sshLite.diagnosticLogging` → reproduce → View → Output → select **SSH Lite** → Select All → Copy.

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

`find <paths> <typeFlag> -iname "<pattern>"` with `typeFlag`: `-type f`, `-type d`, or both. Progressive results via `searchBatch`. Excludes use `-prune` (stops descent into excluded dirs) with an explicit `-print`.

## Native Tool Selection (`sshLite.searchNativeTools`, default `auto`)

Remote command construction is factored into the pure module `src/connection/searchCommandBuilder.ts` (no ssh2/vscode — fully unit-testable). `SSHConnection.searchFiles()` picks the fastest available strategy **per connection** instead of hardcoding grep/find.

**Detection** — lazy, user-triggered (LITE: no auto server commands). On the first `nativeTools:'auto'` search, `getRemoteSearchTools()` runs ONE probe exec (`buildToolProbeCommand()`) returning tool paths + grep/xargs flavor + `uname -s` + `nproc`, parsed by `parseToolProbeOutput()` into a `RemoteSearchTools` profile, memoized for the connection lifetime (reset on disconnect / re-probed on reconnect). `'off'` skips the probe entirely and always uses grep/find.

**Strategy matrix** (chosen in the builder from the probe profile):

| Server profile | Filename search | Content search |
|----------------|-----------------|----------------|
| has `rg` | `fd` if present, else `find -prune` | `rg --no-ignore --hidden -nH ...` |
| GNU, `nproc ≥ 2`, GNU xargs, no rg | `fd` if present, else `find -prune` | `find -print0 \| xargs -0 -P min(nproc,8) grep` |
| GNU, 1 core, no rg | `find -prune` | `grep` (guarded `LC_ALL=C` prefix) |
| non-GNU grep (busybox) | `find -prune` | `find -print0 \| xargs -0 grep` (fixes busybox `--include` silent-0 bug) |
| macOS (Darwin) | `mdfind -onlyin <path> -name` (Spotlight; falls back to find if disabled) | `rg` if present, else grep |
| has plocate/locate + user opts in | `locate`/`plocate` (indexed, may be stale) | — |

**Result-correctness guarantees** (LITE "true data, no missing"):
- rg uses `--no-ignore --hidden` so it matches `grep -r` (no ignore files, includes hidden) — never returns FEWER results. It may return a superset (UTF-16 files grep -I skips), which is allowed.
- rg-path parser drops non-`file:line:text` lines (`requireLineNumber`); the legacy grep path is unchanged.
- `LC_ALL=C` only when `shouldUseCLocale()` allows (not regex, pure ASCII, case-sensitive or no letters) — avoids Unicode case-fold misses.
- `find -prune` is equivalent-or-identical to the old `! -path`/`! -name` excludes, just stops descending.

**Three-tier runtime fallback** — a native tool can never make search worse than grep/find:
1. **Detection**: missing tool or probe failure → legacy from the start.
2. **Execution**: native commands omit `2>/dev/null`; `shouldFallbackToLegacy({resultCount, stderrText, aborted, execError})` re-runs the legacy command ONCE on exec-error or 0-results-with-stderr (the silent-exit-2 class), but NOT on a clean 0 (genuinely no matches — re-running doubles server load) nor on user-abort.
3. **Memory**: after a fallback the tool is marked degraded on the connection's profile so later searches skip it.

Manual override: `sshLite.searchNativeTools: "off"` forces grep/find everywhere (no probe). The `find -prune` and guarded `LC_ALL=C` improvements apply on BOTH settings — they change speed, not results.

**Diagnostic logging** (scopes `search-tools`, `search-exec`, `search-fallback`): probe start/result/error, `strategy-selected` (tool + reason), `command-built`, `exec-done` (durationMs, bytes, lineCount, resultCount, truncated), `zero-results` (stderr-empty classifier), `native-tool-fallback`, `tool-degraded`. Enable `sshLite.diagnosticLogging` → reproduce → copy the SSH Lite Output channel.

## Indexed filename search (opt-in ⚡)

A second toggle (`useIndexBtn`, ⚡) appears beside the find-files button, ONLY in filename mode. Default OFF, per tab, deliberately NOT a persisted setting — an index is stale by nature, and staleness must never be a silent default. When on, each per-server filename search resolves in this precedence (`SearchPanel.createSearchTask`):

1. **Client snapshot** (`FilenameIndexService`) — if the folder was indexed via the `sshLite.indexFolder` command ("Index Folder for Fast Filename Search", folder/connection context menu). One remote listing is gzipped into `globalStorage` keyed by stable `host:port:user::basePath`; later searches match LOCALLY (0 round-trips, instant, works on ANY server including busybox). A build that would exceed `sshLite.filenameIndexMaxEntries` (default 2,000,000) is REFUSED, never truncated (a partial filename index would silently miss files).
2. **Server index** (`SSHConnection.searchIndexed` → `buildLocateCommand`) — plocate/locate. Results are anchored to `basePath + '/'` BOTH server-side (`grep -F`, so siblings can't steal the `head` budget) AND client-side, then basename-filtered to match live `find -iname` semantics. The locate DB mtime (`stat -c %Y`) drives a staleness hint.
3. **Live find/fd** — the fallback when no index exists.

The chosen path + its age are shown in the search activity detail (e.g. `42 results [client index, 2h old]`, `[plocate index, 5h old]`, or `[no file index — used live find]`). `searchIndexed` returns null (never a wrong-empty) whenever no index is available, so the caller always falls back. Logging: `filename-index` scope (`build-start/done/rejected`, `used`) and `search-tools`/`search-exec` (`indexed-search`, `locate-anchor-filter`).

### Progressive Results (searchBatch)

Incremental delivery per task completion. Cross-batch dedup via `globalSeen` set. Webview debounces re-renders (100ms) with scroll preservation. Progress header: `"42 results in 8 files (3/7 done...)"`. Expanded file's match list scrolls horizontally per-file when lines exceed the panel width (no ellipsis truncation).

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

## User Actions

| Action | Primitives | Notes |
|---|---|---|
| Cross-file search | listFiles, readFile, runShort | |
