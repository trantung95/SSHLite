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
    │   ├─ Content mode (grep):
    │   │   Build: grep -rn --include="<include>" --exclude="<exclude>"
    │   │          "<query>" <searchPaths>
    │   │
    │   └─ Find files mode:
    │       Build: find <searchPaths> -name "<pattern>" -type f
    │   │
    │   ├─ Execute via CommandGuard.exec() (tracked in Activity panel)
    │   ├─ Stream stdout line by line
    │   ├─ Parse results: filepath:line:content
    │   ├─ Send to webview: { type: 'updateResults', results }
    │   └─ Stop at searchMaxResults limit
    │
    ▼
Webview displays results (list or tree view)
    │
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
Same-user child paths:
  /home/user          ← parent (searched)
  /home/user/project  ← child (grayed out, skipped)

Cross-user overlaps:
  root@srv:/var/log       ← searched
  admin@srv:/var/log      ← warning (different user, different permissions)
```

---

## Search Cancellation

```
1. New search auto-cancels previous
2. Cancel button in webview
3. Extension sends SIGTERM to remote grep/find processes
4. Stream.close() after SIGTERM
5. Activity panel shows "cancelled" state
```

---

## Configuration

| Setting | Default | Effect |
|---------|---------|--------|
| `searchMaxResults` | `2000` | Max results before stopping |
| `filterMaxResults` | `1000` | Max results for file filter |
