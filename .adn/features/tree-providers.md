# Tree Providers

Covers `HostTreeProvider`, `FileTreeProvider`, and `FileDecorationProvider` — the three main UI components for the sidebar panels.

---

## HostTreeProvider (`src/providers/HostTreeProvider.ts`)

Displays SSH hosts in a hierarchical tree: Server → Users → Pinned Folders.

### Tree Hierarchy

```
sshLite.hosts
  └─ ServerTreeItem (server:port)
       ├─ UserCredentialTreeItem (username1) ← click to connect
       │   └─ PinnedFolderTreeItem (/home/user/project)
       ├─ UserCredentialTreeItem (username2)
       └─ AddCredentialTreeItem (+ Add User...)
```

### Tree Item Types and contextValues

| Class | contextValue Pattern | When Shown |
|-------|---------------------|------------|
| `ServerTreeItem` | `server`, `savedServer`, `connectedServer.saved` | Always |
| `UserCredentialTreeItem` | `credential`, `credentialConnected` | Under servers |
| `CredentialTreeItem` | `credentialEntry` | Legacy (may be deprecated) |
| `PinnedFolderTreeItem` | `pinnedFolder`, `pinnedFolderConnected` | Under credentials |
| `AddCredentialTreeItem` | `addCredential` | Under servers |

### Context Value Matching in package.json

```json
// Menu items use regex matching:
"when": "viewItem =~ /^connectedServer/"     // Matches connectedServer.saved
"when": "viewItem =~ /^(savedServer|connectedServer\\.saved)$/"
```

**Critical**: The `=~` operator does regex matching. Dot in `connectedServer.saved` is escaped as `\\.` in the `when` clause regex.

### Host Filter

```
sshLite.filterHosts → prompt for pattern → filter tree
  - Matches against: name, host, username
  - Supports glob patterns (* and ?)
  - Context key: sshLite.hasHostFilter (controls clear button visibility)
```

### Icons & Connection State

| State | Icon | Color | Tooltip |
|-------|------|-------|---------|
| Connected | `vm-running` | Green (`charts.green`) | Server name |
| Last connection failed | `vm-outline` | Orange (`charts.orange`) | Error details + time ago |
| Saved (no failure) | `vm` | Default gray | "Disconnected" |
| SSH config only | `vm-outline` | Default gray | "Disconnected" |

#### Failed Connection Indicator

When a connection fails, `ConnectionManager.saveLastConnectionAttempt()` stores the failure in `globalState` (key: `sshLite.lastConnectionAttempts`). On successful reconnection, the failure is cleared.

`getServerItems()` queries `connectionManager.getLastConnectionAttempt()` for each disconnected server. The most recent failed attempt (across all hosts in a server group) is passed to `ServerTreeItem`.

Rich tooltip via `vscode.MarkdownString`:
```
**Server Name** ⚠️
- Status: Last connection failed 2h ago
- Error: Authentication failed
```

`formatTimeAgo()` helper converts timestamps to human-readable strings: "just now", "2m ago", "3h ago", "5d ago".

---

## FileTreeProvider (`src/providers/FileTreeProvider.ts`)

Remote file browser tree with caching, filtering, drag & drop, and preloading.

### Tree Hierarchy

```
sshLite.fileExplorer
  └─ ConnectionTreeItem (server name)
       ├─ ParentFolderTreeItem (..)  ← inline "Show tree from root" button
       ├─ FileTreeItem (file/folder)
       │    └─ FileTreeItem (nested)
       └─ ...
```

### Caching Strategy

```typescript
private fileCache: Map<string, CacheEntry>;
// Key: `${connectionId}:${remotePath}`
// Value: { files: IRemoteFile[], timestamp: number }

// Cache TTL: treeRefreshIntervalSeconds (default 10s)
// Cache cleared on: disconnect, explicit refresh, filter change
```

### Filter System

Two filter types:

**Content Filter** (`sshLite.filterFiles`):
- Searches file CONTENTS on server (via grep)
- Results shown as flat list
- Limit: `filterMaxResults` (default 1000)

**Filename Filter** (`sshLite.filterFileNames`):
- Filters tree by file NAME matching
- Available on both **connection** (server level) and **folder** items
- Glob pattern support (`*.ts`, `config*`)
- Plain text = substring match
- **Multiple simultaneous filters** on different folders (additive, not replacing)
- **Filter modes**: files only (default), folders only, or both
- **Match count per folder**: Recursive count shown as `(N)` in description
- Directories with matching names are highlighted (not grayed out)
- Empty folders after filter are grayed out (checked via `isEmptyAfterFilter`)
- Connection contextValue changes: `connection` → `connection.filtered` when active

#### Multi-Filter Architecture

```typescript
export type FilterMode = 'files' | 'folders' | 'both';

interface ActiveFilter {
  pattern: string;                      // lowercase
  basePath: string;
  connectionId: string;
  highlightedPaths: Set<string>;
  matchCounts: Map<string, number>;     // folderPath → recursive count
  filterMode: FilterMode;
}

// Key: "connectionId:basePath"
private activeFilters: Map<string, ActiveFilter> = new Map();
```

#### Filter Mode Behavior

| Mode | Files | Directories |
|------|-------|-------------|
| `files` | Filtered by pattern | Always shown (for navigation) |
| `folders` | Always shown | Filtered by pattern |
| `both` | Filtered by pattern | Filtered by pattern |

#### Key Methods

| Method | Purpose |
|--------|---------|
| `setFilenameFilter(pattern, basePath, conn, filterMode)` | Add/update filter; calls `searchFiles` with `findType` |
| `clearFilenameFilter(filterKey?)` | Clear specific or all filters |
| `matchesFilenameFilter(connId, file)` | Check all applicable filters for visibility |
| `isEmptyAfterFilter(connId, folderPath)` | Gray out folders: checks highlightedPaths AND folder name match |
| `isPathHighlighted(connId, file)` | Check any filter highlights this file |
| `getMatchCount(connId, folderPath)` | Sum recursive match counts from all filters |
| `nameMatchesPattern(name, pattern)` | Shared substring/glob matcher |
| `shouldHighlightByFilter(filter, file)` | Local pattern match (fallback for symlinks) |

#### Match Count Computation

After `searchFiles` returns results, `setFilenameFilter` walks up parent paths from each result to `basePath`, incrementing `matchCounts` for each ancestor folder. Displayed in `FileTreeItem.description` as `(N)`.

#### QuickPick Input (extension.ts)

Filter command uses `vscode.window.createQuickPick<FilterModeItem>()` with text input at top and 3 mode items below:
- `$(file) Files only` (default)
- `$(folder) Folders only`
- `$(files) Both`

User types pattern and selects mode, then presses Enter.

#### Selective Clearing

- **Inline clear** (clicking clear on filtered folder): Clears that specific filter via `clearFilenameFilter("connId:basePath")`
- **Toolbar clear**: Clears ALL filters via `clearFilenameFilter()`
- Decoration provider synced via `rebuildFilterState()` after changes

```typescript
matchesFilter(file: IRemoteFile, pattern: string): boolean {
  if (!pattern) return true;
  if (file.isDirectory) return true;  // Always show dirs

  const hasGlob = pattern.includes('*') || pattern.includes('?');
  if (!hasGlob) {
    return fileName.toLowerCase().includes(pattern.toLowerCase());
  }
  // Convert glob to regex
  const regex = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(regex, 'i').test(fileName);
}
```

### Reveal Auto-Clear

When revealing a file in the tree (`sshLite.revealInTree`), if the file is hidden by the current filename filter, the filter is auto-cleared. Only clears if ALL filters would need clearing; otherwise clears the specific blocking filter.

```typescript
fileTreeProvider.setOnFilterCleared(() => {
  fileDecorationProvider.clearFilteredFolder();
  setContext('sshLite.hasFilenameFilter', false);
});
```

### Expansion State Tracking

```typescript
private expandedFolders: Set<string>;
// Key format: "connectionId:path" or "connection:connectionId"

trackExpand(element: TreeItem) → add to Set
trackCollapse(element: TreeItem) → remove from Set
// Connection collapse only removes connection-level key, preserves sub-folder expansion
// Full cleanup happens in clearExpansionState() on disconnect
```

### Connection Change Refresh Strategy

```typescript
private lastKnownConnectionIds: Set<string>;

debouncedConnectionRefresh():
  - Compares current connection IDs vs lastKnownConnectionIds
  - Structural change (add/remove): full tree refresh (_onDidChangeTreeData.fire())
  - No structural change: targeted refreshConnection(id) per connection
  - Preserves expansion state across connection state changes
```

### Preload Logging

Preload operations log to console with `[SSH Lite Preload]` prefix:
- Queue count on `preloadSubdirectories()`
- Completion with item count on `enqueueDirectoryPreload()`
- Errors on preload failures

### Tree Item Properties

```typescript
class FileTreeItem extends vscode.TreeItem {
  file: IRemoteFile;
  connection: SSHConnection;
  shouldBeExpanded: boolean;    // Preserved expansion state
  isOpenInTab: boolean;         // Eye icon for open files
  isHighlighted: boolean;       // Yellow highlight for watched files
  isLoading: boolean;           // Spinner icon during load
  isFiltered: boolean;          // Filename filter active
  isEmptyAfterFilter: boolean;  // Gray out empty filtered folders
}
```

### Show Tree From Root

An inline button on the `ParentFolderTreeItem` (`..`) row that navigates to `/` with auto-expand from root down to the current path. No special mode — just normal tree navigation with smart expansion.

#### How it works

1. User clicks tree icon on `..` row at `/home/user/projects`
2. `sshLite.showTreeFromRoot` command:
   - Builds expand paths: `/home`, `/home/user`, `/home/user/projects`
   - Queues them via `setAutoExpandPaths()` (consumed once by `getChildren`)
   - Loads ancestor dirs (`/`, `/home`, `/home/user`, `/home/user/projects`) into cache
   - Sets `currentPath = '/'`
3. Tree renders from `/` with path segments auto-expanded down to `projects/`
4. Already-expanded folders stay expanded
5. No "Back to flat view" — user navigates normally from the root tree

#### Auto-Expand Mechanism

Pending auto-expand paths are stored in `pendingAutoExpandPaths: Map<string, Set<string>>` and consumed once by `getChildren()` / `buildDirectoryItems()`:

```typescript
const autoExpandPaths = this.pendingAutoExpandPaths.get(connectionId);
const shouldAutoExpand = file.isDirectory && autoExpandPaths?.has(file.path);
const state = shouldAutoExpand ? Expanded : Collapsed;
// Paths are cleared after 500ms timeout to prevent stale expand state
```

#### Key Methods

```typescript
setAutoExpandPaths(connectionId: string, expandPaths: Set<string>): void
// Queue paths for auto-expand on next render (merges with existing)

async loadAncestorDirs(connection: SSHConnection, targetPath: string): Promise<void>
// Load all directories from / to targetPath into cache
```

---

### Smart Reveal (Preserve Tree State)

`revealFile()` expands the tree from the current view to the target file **without collapsing or resetting** the existing tree state. Used by search "Reveal in File Explorer" and "Reveal in Tree" commands.

#### Case A: File Under currentPath

File is reachable from the current view (e.g., currentPath = `/home/user`, file = `/home/user/projects/src/foo.ts`):
- Do NOT change `currentPath` — tree stays exactly as-is
- `loadIntermediateDirs()` caches all directories between currentPath and file's parent
- VS Code's `reveal()` uses `getParent()` to trace back and auto-expand each level

#### Case B: File Outside currentPath

File is not under current view (e.g., currentPath = `/home/user/projects`, file = `/var/log/syslog`):
- `navigateToRootWithExpand()` navigates to `/` with auto-expand
- Loads ancestors for BOTH paths (original + target)
- Both paths + all currently expanded folders are queued as auto-expand paths
- `reveal()` selects the target file

#### Key Methods

```typescript
private async loadIntermediateDirs(connection, fromPath, toPath): Promise<void>
// Loads all dirs between fromPath and toPath into cache

private async navigateToRootWithExpand(connection, originalPath, remotePath): Promise<void>
// Navigates to /, loads ancestors for both paths, queues auto-expand paths
```

---

### 3-State Expand/Collapse Toggle

Each tree view has a 3-state toggle button:
```
State 0: Collapsed → click → State 1: Fully expanded
State 1: Fully expanded → click → State 2: First level only
State 2: First level → click → State 0: Collapsed
```

Context key: `sshLite.fileExplorer.expandState` (0, 1, or 2)

### Drag & Drop

Registered via `dragAndDropController: fileTreeProvider` on createTreeView. Supports multi-select operations (`canSelectMany: true`).

---

## FileDecorationProvider (`src/providers/FileDecorationProvider.ts`)

Provides badges and colors for file tabs and tree items. Supports **multiple simultaneous filters** via `Set`-based state.

### Badge Types

| Badge | Color | Meaning | Source |
|-------|-------|---------|--------|
| `↑` | Yellow (`charts.yellow`) | File uploading | `FileService.uploadingFiles` Set |
| `✗` | Red (`errorForeground`) | Upload failed | `FileService.failedUploadFiles` Set |
| `F` | Blue (`charts.blue`) | Filtered folder | Filename filter active |
| — | Gray (`disabledForeground`) | Empty after filter / disconnected | No matching files in folder |

### Multi-Filter State

```typescript
private filteredFolderUris: Set<string> = new Set();     // Blue "F" badge
private filterHighlightedUris: Set<string> = new Set();  // Highlighted (not grayed)
private filterBasePrefixes: Set<string> = new Set();      // Base paths for gray check
```

All three are **additive** — `setFilteredFolder()` and `setFilenameFilterPaths()` add to the sets. Use `clearFilteredFolder(connId, path)` to remove specific entries, or `clearFilteredFolder()` to clear all.

`rebuildFilterState(filterStates)` replaces all state atomically from FileTreeProvider's `getFilenameFilterState()`.

### Event Subscriptions

```typescript
constructor(fileService: FileService, connectionManager: ConnectionManager) {
  fileService.onFileMappingsChanged(() => this.refresh());
  fileService.onUploadStateChanged(() => this.refresh());
  connectionManager.onDidChangeConnections(() => this.refresh());
  connectionManager.onConnectionStateChange(() => this.refresh());
}
```

### Implementation Pattern

```typescript
provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
  // ssh:// URIs: filtered folder badges + empty folder graying
  if (uri.scheme === 'ssh') {
    if (this.filteredFolderUris.has(uriString)) → blue "F" badge
    for (prefix of this.filterBasePrefixes):
      if under prefix && !highlighted → gray "No matching files"
  }
  // file:// URIs: upload state + connection state decorations
  if (uri.scheme === 'file') {
    uploading → "↑" badge
    failed → "✗" badge
    no mapping → gray "Not connected"
    no connection → gray "Connection lost"
  }
}
```

**Critical**: Uses `normalizeLocalPath(uri.fsPath)` for Windows drive letter normalization. Without this, Map lookups fail.
