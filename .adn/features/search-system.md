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
{ type: 'updateResults', results: SearchResult[] }
{ type: 'searchComplete', stats: { files, matches, duration } }
{ type: 'updateServerConnection', serverId, connected }
```

**Webview → Extension** (`vscode.postMessage`):
```typescript
{ type: 'search', query, include, exclude, mode }    // Start search
{ type: 'toggleServer', serverId, checked }           // Toggle checkbox
{ type: 'openResult', result: { connectionId, path, line } }
{ type: 'cancel' }                                     // Cancel search
{ type: 'removeServerPath', serverId, pathIndex }     // Remove path
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
  /home/user          ← parent
  /home/user/project  ← child (grayed out, skipped during search)

Cross-user overlaps:
  root@server:/var/log    ← warning shown
  admin@server:/var/log   ← different user, may have different access
```

---

## Search Execution

### Content Search (grep mode)

```
For each checked server with paths:
  1. Build grep command:
     grep -rn --include="<include>" --exclude="<exclude>" "<query>" <paths>
  2. Execute via CommandGuard.exec() (tracked in Activity panel)
  3. Stream results line by line
  4. Parse: filepath:line:content
  5. Send to webview as they arrive
  6. Stop at searchMaxResults limit
```

### Find Files Mode

```
For each checked server with paths:
  1. Build find command:
     find <paths> -name "<pattern>" -type f
  2. Execute via CommandGuard.exec()
  3. Parse results (one path per line)
  4. Send to webview
```

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

---

## Sort Order

Toggle between checked-first and alphabetical:

```typescript
// Persisted in globalState: sshLite.searchSortOrder
type SortOrder = 'checked' | 'alphabetical';
```

Sort by checked: servers with checkboxes enabled appear first.
