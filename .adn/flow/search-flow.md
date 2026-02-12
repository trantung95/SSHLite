# Search Flow

Complete flow from opening the search panel to displaying results.

---

## Flow Diagram

```
User opens search (sshLite.showSearch or Ctrl+Shift+F)
    │
    ▼
extension.ts: sshLite.showSearch handler
    │
    ├─ Get SearchPanel singleton
    ├─ Build server search entries (all known hosts)
    ├─ searchPanel.setServerList(entries)
    ├─ searchPanel.show()
    │
    ▼
SearchPanel creates/reveals WebviewPanel
    │
    ├─ Generate HTML (search input, server checkboxes, results area)
    ├─ Set retainContextWhenHidden: true
    ├─ Setup message handlers
    │
    ▼
User configures search:
    ├─ Toggle server checkboxes
    ├─ Add search paths (via tree context menu → sshLite.searchInScope)
    ├─ Type query in search box
    ├─ Set include/exclude patterns
    ├─ Choose mode: Content search (grep) or Find files (find)
    │
    ▼
User presses Enter or clicks Search
    │
    ▼
Webview sends: { type: 'search', query, include, exclude, mode }
    │
    ▼
SearchPanel.performSearch()
    │
    ├─ Cancel any running search (SIGTERM to remote processes)
    │
    ├─ Auto-connect disconnected servers:
    │   For each checked + disconnected server with credential:
    │     → connectionManager.connectWithCredential()
    │     → Track as auto-connected
    │
    ├─ For each checked + connected server:
    │   │
    │   ├─ Filter out redundant child paths (isChildPath)
    │   ├─ Default to / if no explicit paths
    │   │
    │   ├─ File-level worker pool (if parallelProcesses > 1):
    │   │   ├─ Seed work queue with search path (or filtered subdirs at root)
    │   │   ├─ N workers consume from shared queue:
    │   │   │   ├─ DIR item → listEntries(path) → batch files (32KB) + add subdirs
    │   │   │   └─ FILES item → searchFiles(filePaths[], query)
    │   │   ├─ Filter system dirs if root / + searchExcludeSystemDirs
    │   │   └─ Fallback: if listEntries fails → grep -r on that dir
    │   │
    │   ├─ Single search (fallback when parallelProcesses = 1):
    │   │   └─ searchFiles(path, query, options)
    │   │
    │   ├─ Each completed batch → sends searchBatch:
    │   │   { type: 'searchBatch', results, totalResults,
    │   │     completedCount, totalCount, hitLimit, done }
    │   └─ Stop at searchMaxResults limit
    │
    ▼
Webview displays results progressively (list or tree view)
    │
    ├─ Results appended as each searchBatch arrives
    ├─ Debounced re-render (100ms), immediate on done
    ├─ Progress header: "42 results in 8 files (3/7 done...)"
    ├─ Grouped by server (tree) or flat (list)
    ├─ Click result → webview sends: { type: 'openResult', result }
    │
    ▼
SearchPanel handles openResult:
    │
    ├─ Call openFileCallback(connectionId, path, line)
    │   → Opens file in editor at specific line
    └─ File opens in VS Code editor with cursor at match line
```

---

## Auto-Connect / Auto-Disconnect

### Auto-Connect (before search)

```
For each checked server:
  ├─ Connected? → Use directly
  ├─ Disconnected + has saved credential? → Auto-connect
  │   → Track server as "auto-connected"
  └─ Disconnected + no credential? → Skip with warning
```

### Auto-Disconnect (after search)

```
For each auto-connected server:
  ├─ Had results? → Keep connected (user may open files)
  └─ No results? → Disconnect (clean up)
```

---

## Search Scope Management

### Adding Scopes

Paths are added to servers via tree context menus:

```typescript
// From file tree: right-click folder → "Search in Scope"
searchPanel.addScope(remotePath, connection, isFile);

// Additive: multiple paths per server
// Server: 192.168.1.100:22:root
//   paths: ["/home/user", "/var/log", "/etc"]
```

### Redundancy Detection

```
Same-user child paths (including root):
  /                   ← parent (searched, catches all)
  /home/user          ← child (grayed out, skipped)
  /home/user/project  ← child (grayed out, skipped)

Cross-user overlaps:
  root@srv:/           ← searched
  admin@srv:/var/log   ← warning (different user, different permissions)

Implicit root:
  Server checked with no paths → defaults to / search
  Adding /home/user → auto-inserts / first, child marked redundant
```

---

## Search Cancellation & searchId Safety

```
1. New search auto-cancels previous (via AbortController)
2. Cancel button in webview → postMessage({ type: 'cancelSearch' })
3. Extension aborts AbortController → signal propagates to all search tasks
4. SSHConnection sends SIGTERM to remote grep/find processes, then stream.close()
5. searchId guard: every postMessage and counter mutation checks:
   if (signal.aborted || searchId !== this.currentSearchId) return
6. cancelSearch() iterates currentSearchActivityIds to cancel all tracked activities
7. finally block only resets isSearching if searchId === this.currentSearchId
8. Webview tracks currentSearchId and discards searchBatch with mismatched IDs
9. Prevents: stale results, corrupted progress, activity leaks on rapid cancel/re-search
```

---

## Configuration

| Setting | Default | Effect |
|---------|---------|--------|
| `searchMaxResults` | `2000` | Max results before stopping |
| `filterMaxResults` | `1000` | Max results for file filter |
| `searchParallelProcesses` | `20` | Default parallel workers per folder (per-server overridable, min 5) |
| `searchExcludeSystemDirs` | `true` | Auto-exclude /proc, /sys, /dev, /run when searching from root / |
