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
{ type: 'updateState', serverList, isSearching, results, ... }
{ type: 'searching', query, scopeServers }             // Search started, reset UI
{ type: 'searchBatch', results, totalResults,           // Progressive results
  completedCount, totalCount, hitLimit, limit, done }
{ type: 'systemDirsExcluded', dirs: string[] }          // Excluded system dirs notice
{ type: 'updateServerConnection', serverId, connected }
```

**Webview → Extension** (`vscode.postMessage`):
```typescript
{ type: 'search', query, include, exclude, mode }    // Start search
{ type: 'toggleServer', serverId, checked }           // Toggle checkbox
{ type: 'openResult', result: { connectionId, path, line } }
{ type: 'cancelSearch' }                                // Cancel search
{ type: 'removeServerPath', serverId, pathIndex }     // Remove path
{ type: 'searchIncludeSystemDirs' }                   // Re-search including system dirs
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
     grep -rnH --include="<include>" --exclude="<exclude>" -- "<query>" <paths>
  2. Execute via SSHConnection.searchFiles() (supports single path or string[])
  3. Parse results: filepath:line:content
  4. Send progressive searchBatch to webview as each task completes
  5. Stop at searchMaxResults limit
```

### Find Files Mode

```
For each checked server with non-redundant paths:
  1. Build find command:
     find <paths> -type f -iname "<pattern>"
  2. Execute via SSHConnection.searchFiles()
  3. Parse results (one path per line)
  4. Send progressive searchBatch to webview
```

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

**Key properties**: Zero duplication (each file searched exactly once), zero missed files (files at every directory level explicitly listed), perfect load balance (file-level granularity — workers never idle).

**Batch size**: 32KB total file paths per batch — safe across all server OS variants (Linux, macOS, FreeBSD, Solaris, AIX).

**Fallback**: If `listEntries()` fails for a directory, falls back to recursive `grep -r` on that directory.

**System directory exclusion** (when searching from root `/`):
- Auto-excludes: `/proc`, `/sys`, `/dev`, `/run`, `/snap`, `/lost+found`
- Webview shows dismissible info bar: "System directories excluded: /proc, /sys, ..."
- User can click "Include all" to re-search without exclusion

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

## Sort Order

Toggle between checked-first and alphabetical:

```typescript
// Persisted in globalState: sshLite.searchSortOrder
type SortOrder = 'checked' | 'alphabetical';
```

Sort by checked: servers with checkboxes enabled appear first.
