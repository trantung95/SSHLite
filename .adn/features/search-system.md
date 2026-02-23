# Search System

Covers the `SearchPanel` webview for cross-server search, including server checkboxes, auto-connect/disconnect, redundancy detection, and find-files mode.

---

## SearchPanel (`src/webviews/SearchPanel.ts`)

Singleton webview panel for searching across multiple SSH servers simultaneously.

### Architecture

```
┌──────────────────────────────────┐
│        SearchPanel (TS)          │  Extension side
│  - Server list management        │
│  - Search execution              │
│  - Auto-connect/disconnect       │
├──────────────────────────────────┤
│      postMessage / onMessage     │  Message protocol
├──────────────────────────────────┤
│        Webview (HTML/JS)         │  Browser side
│  - Search input + controls       │
│  - Server checkboxes             │
│  - Results display (list/tree)   │
└──────────────────────────────────┘
```

### Webview Communication Protocol

**Extension → Webview** (`panel.webview.postMessage`):
```typescript
{ type: 'updateState', serverList, isSearching, results, globalMaxSearchProcesses, ... }
{ type: 'searching', query, scopeServers, searchId }  // Search started, reset UI + searchId
{ type: 'searchBatch', results, totalResults,           // Progressive results
  completedCount, totalCount, hitLimit, limit, done, searchId }
{ type: 'updateServerConnection', serverId, connected }
```

**Webview → Extension** (`vscode.postMessage`):
```typescript
{ type: 'search', query, include, exclude, mode }    // Start search
{ type: 'toggleServer', serverId, checked }           // Toggle checkbox
{ type: 'openResult', result: { connectionId, path, line } }
{ type: 'cancelSearch' }                                // Cancel search
{ type: 'removeServerPath', serverId, pathIndex }     // Remove path
{ type: 'setServerMaxProcesses', serverId, value }    // Per-server worker override (null = reset)
```

---

## Server List Management

Each server has search configuration:

```typescript
interface ServerSearchEntry {
  id: string;           // Connection ID (host:port:username)
  hostConfig: IHostConfig;
  credential: SavedCredential | null;
  connected: boolean;
  checked: boolean;     // Checkbox state
  disabled: boolean;    // No credential + not connected
  searchPaths: string[];  // Paths to search in
  maxSearchProcesses?: number;  // Per-server override (null = use global default)
}
```

### Key APIs

```typescript
searchPanel.setServerList(entries)                  // Populate all servers (preserves existing paths/checked)
searchPanel.addScope(path, connection, isFile?)     // Add path to server (additive)
searchPanel.removeServerPath(serverId, pathIndex)   // Remove specific path
searchPanel.toggleServer(serverId, checked)         // Toggle server checkbox
searchPanel.updateServerConnection(id, connected)   // Real-time connection updates
```

### Redundancy Detection

When multiple paths are added to the same server:

```
Same-user child paths:
  /                   ← parent (root catches everything)
  /home/user          ← child (grayed out, skipped during search)
  /home/user/project  ← child (grayed out, skipped during search)

Cross-user overlaps:
  root@server:/       ← warning shown (root covers everything)
  admin@server:/var/log   ← different user, may have different access
```

Uses `isChildPath()` helper that correctly handles root `/` as parent (avoids `startsWith("//")` bug).

**Implicit root**: When adding a path to a checked server with no existing paths, `/` is auto-inserted first so the child is properly marked redundant.

---

## Search Execution

### Content Search (grep mode)

```
For each checked server with non-redundant paths:
  1. Build grep command:
     grep -rnHI --include="<include>" --exclude="<exclude>" -- "<query>" <paths>
     -I: skip binary files
  2. Execute via SSHConnection.searchFiles() (supports single path or string[])
  3. Parse results: filepath:linenum:content
  4. Send progressive searchBatch to webview as each task completes
  5. Stop at searchMaxResults limit
```

**Data correctness**: Output accumulated via `Buffer.concat()` (not string concatenation) to prevent UTF-8 multi-byte character corruption at chunk boundaries.

**Channel retry**: SSH servers limit concurrent channels (`MaxSessions`, often 10). With many parallel workers, excess channel opens get rejected with "Channel open failure". The `_execChannel()` helper retries with exponential backoff (200ms, 400ms, 800ms, 1600ms, 3200ms, max 5 retries) — used by both `exec()` and `searchFiles()`. This ensures no work is lost due to channel congestion.

### Find Files Mode

```
For each checked server with non-redundant paths:
  1. Build find command:
     find <paths> <typeFlag> -iname "<pattern>"
     typeFlag: -type f (files), -type d (dirs), \( -type f -o -type d \) (both)
  2. Execute via SSHConnection.searchFiles({ findType: 'f'|'d'|'both' })
  3. Parse results (one path per line)
  4. Send progressive searchBatch to webview
```

The `findType` option is also used by the filename filter system for filter modes (files/folders/both).

### Progressive Results (searchBatch)

Results are delivered incrementally as each search task completes:

```
Task 1 done (server A: /home)   → searchBatch { results, done: false, completedCount: 1/4 }
Task 2 done (server A: /var)    → searchBatch { results, done: false, completedCount: 2/4 }
Task 3 done (server B: /opt)    → searchBatch { results, done: false, completedCount: 3/4 }
Task 4 done (server B: /etc)    → searchBatch { results, done: true,  completedCount: 4/4 }
```

- Cross-batch deduplication via `globalSeen` set
- Webview debounces re-renders (100ms) with scroll position preservation
- Progress header: `"42 results in 8 files (3/7 done...)"`
- Failed tasks send empty batch with progress update

### Parallel Search (File-Level Worker Pool)

For large directories, search uses a file-level worker pool for optimal load balancing:

```
Path /opt with parallelProcesses=4:
  1. Seed work queue: [{type:'dir', path:'/opt'}]
  2. Worker picks DIR item → listEntries('/opt'):
     files: [f1.ts, f2.ts, ..., f80.ts], dirs: [/opt/a, /opt/b, /opt/c]
     → Batch files by byte size (32KB limit): [{files:[f1..f50]}, {files:[f51..f80]}]
     → Add subdirs: [{dir:/opt/a}, {dir:/opt/b}, {dir:/opt/c}]
  3. Workers pick next items from shared queue:
     Worker 1 → grep f1-f50
     Worker 2 → grep f51-f80
     Worker 3 → listEntries(/opt/a) → more items...
     Worker 4 → listEntries(/opt/b) → more items...
  4. Each completed batch sends searchBatch progressively
```

**Key properties**: Zero duplication (each file searched exactly once), zero missed files (files at every directory level explicitly listed), perfect load balance (file-level granularity — workers never idle). `listEntries` uses `find -L` to follow symlinks, so symlinked directories and files are discovered.

**Batch size**: 32KB total file paths per batch — safe across all server OS variants (Linux, macOS, FreeBSD, Solaris, AIX).

**Fallback**: If `listEntries()` fails for a directory, falls back to recursive `grep -r` on that directory.

**`pendingDirListings` counter**: Workers don't exit when the queue is momentarily empty — they poll (50ms) until `pendingDirListings === 0` confirms all dir listings have completed. This prevents premature worker exit during deep directory discovery and keeps all workers active.

**Skip worker pool when**:
- `searchParallelProcesses === 1`
- Path is a file (`isFile === true`)

### Auto-Connect

When search starts, disconnected servers with saved credentials auto-connect:

```
1. Check each checked server
2. If disconnected + has credential → auto-connect
3. Track auto-connected servers
4. Search proceeds after all connections ready
```

### Auto-Disconnect

After search completes, auto-connected servers with no results get disconnected:

```
1. Check each auto-connected server
2. If server had 0 results → disconnect
3. If server had results → keep connected (user may want to open files)
```

### Search Cancellation

- New search auto-cancels previous running search
- Cancel button sends SIGTERM to remote grep/find processes before closing stream
- Activity panel shows cancelled state
- Both `.then()` and `.catch()` handlers on search promises check `signal.aborted` to prevent stale `searchBatch` messages from being posted to the webview after cancel

---

## Per-Server Search Processes

Each server can override the global `searchParallelProcesses` setting inline in the search panel. Overrides are persisted in `globalState` under key `sshLite.serverSearchSettings`.

### UI

Below each server's search paths, a "Workers" control shows the current value:
- `Workers: 20 (default)` — click to edit, shows inline number input
- `Workers: 8 ×` — override shown in accent color, `×` resets to global default

### Persistence

```typescript
interface ServerSearchSettings {
  [hostId: string]: { maxSearchProcesses?: number };
}
// Stored in: globalState.get('sshLite.serverSearchSettings', {})
```

Clamped to min 5, max 50. Setting to `null` clears the override.

### Usage in Search

```typescript
const globalParallelProcesses = config.get<number>('searchParallelProcesses', 20);
// Inside per-server loop:
const parallelProcesses = server.maxSearchProcesses ?? globalParallelProcesses;
```

### Dynamic Worker Adjustment (Mid-Search)

Worker count changes take effect immediately during an active search:

```typescript
// SearchPanel tracks active worker pools
private activeWorkerPools: Map<string, {
  desiredWorkerCount: number;
  activeWorkerCount: number;
  addWorker: () => void;
}>;
```

When `setServerMaxProcesses` fires:
1. Find all active pools for this server (keyed by `serverId:path`)
2. Update `desiredWorkerCount` on each pool
3. If increasing: spawn additional workers via `addWorker()`
4. If decreasing: workers self-terminate at the top of their loop when `activeWorkerCount > desiredWorkerCount` (minimum 1 worker always stays alive)
5. Pools are cleaned up on search cancel/complete (`activeWorkerPools.clear()`)

---

## Search Instance Tracking (searchId)

A monotonic counter `currentSearchId` prevents stale messages from cancelled/previous searches from corrupting the current search state.

### Flow

1. `performSearch()` increments `++this.currentSearchId` at start
2. Every `postMessage` and counter mutation is guarded: `if (signal.aborted || searchId !== this.currentSearchId) return`
3. `searchId` is included in all search messages (`searching`, `searchBatch`)
4. Webview tracks `currentSearchId` and discards `searchBatch` messages with mismatched IDs
5. `cancelSearch()` iterates `currentSearchActivityIds` to cancel all tracked activities
6. `finally` block only resets `isSearching` if `searchId === this.currentSearchId`

---

## Keep Results (Tab Bar)

Pin current search results as tabs for comparison. Session-only (not persisted). Max 10 tabs. Each tab has completely isolated state (query, options, results, expand state).

### Tab State Model

```javascript
function createTabState() {
  return {
    id, query, include, exclude,           // Search parameters
    caseSensitive, useRegex, findFilesMode, // Toggle states
    results, scopeServers, hitLimit, limit, // Result data
    searchId, searching,                    // Active search tracking
    expandedFiles, expandedTreeNodes,       // UI expand state
    treeViewFirstExpand, searchExpandState, viewMode, // View state
    timestamp,
  };
}

let resultTabs = [];              // Kept tab state objects
let activeTabId = null;           // null = Current tab
let currentTab = createTabState(); // Always-present "Current" tab
let tabSearchIdMap = {};          // { searchId: tabId } — routes searchBatch to kept tabs
```

### UI

Tab bar appears above results when `resultTabs.length > 0`:
- Kept tabs show query + result count + searching indicator (`⟳`), with `×` close button
- "Current" tab (always last) shows live search results
- Active tab highlighted with accent border
- Tabs with active searches show italic label

### Pin Flow (Keep Results Mid-Search)

1. Click pin icon in results header (shown on Current tab when results exist)
2. Save current input state into the tab being kept
3. Move `currentTab` to `resultTabs` (becomes a kept tab)
4. If the tab has an active search, register `tabSearchIdMap[searchId] = tabId` to route future `searchBatch` messages to the kept tab
5. Create a fresh `currentTab` and restore it to the UI
6. Tab bar re-rendered, "Current" tab becomes active with empty inputs

### Tab Switch (Save/Restore)

On every tab switch:
1. `saveCurrentInputState()` captures UI state into outgoing tab
2. `restoreTabState(tab)` applies incoming tab's state to UI (inputs, toggles, buttons)
3. Search/cancel button visibility updated based on `tab.searching`

### searchBatch Routing

When `searchBatch` arrives:
1. Check `tabSearchIdMap[searchId]` — if routed to a kept tab, append results to that tab
2. If routed tab is the active tab, re-render results; otherwise just update tab bar count
3. On `done`, remove the routing entry and mark tab as not searching
4. If not routed, fall through to normal current-tab handling (stale message check via `currentSearchId`)

### Tab Close (LITE Cleanup)

When closing a tab:
1. If the tab has an active search, send `cancelSearch` message to stop server-side work
2. Remove `tabSearchIdMap` entry for the tab's searchId
3. Free memory: clear `results`, `scopeServers`, `expandedFiles`, `expandedTreeNodes`
4. If closing the active tab, switch to Current tab and restore its state

---



Toggle between checked-first and alphabetical:

```typescript
// Persisted in globalState: sshLite.searchSortOrder
type SortOrder = 'checked' | 'alphabetical';
```

Sort by checked: servers with checkboxes enabled appear first.
