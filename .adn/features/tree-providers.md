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
       ├─ ParentFolderTreeItem (..)
       ├─ ShowTreeFromRootItem (Show tree from root) / BackToFlatViewItem (Back to flat view)
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
- Directories always shown (for navigation)
- Empty folders after filter are grayed out
- Connection contextValue changes: `connection` → `connection.filtered` when active

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

When revealing a file in the tree (`sshLite.revealInTree`), if the file is hidden by the current filename filter, the filter is auto-cleared:

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

### Tree-From-Root Mode

A button next to `..` (ParentFolderTreeItem) that switches from flat navigation to a full hierarchical tree from `/` to the current path level, with auto-expanded path segments.

#### Tree Item Types

| Class | contextValue | Purpose |
|-------|-------------|---------|
| `ShowTreeFromRootItem` | `showTreeFromRoot` | Button to enter tree-from-root mode |
| `BackToFlatViewItem` | `backToFlatView` | Button to exit back to flat navigation |

#### Instance Variables

```typescript
private treeFromRootConnections: Set<string> = new Set();           // connectionIds in tree-from-root mode
private treeFromRootOriginalPaths: Map<string, string> = new Map(); // connectionId → original path before switch
private treeFromRootExpandPaths: Map<string, Set<string>> = new Map(); // connectionId → paths to auto-expand
```

#### Flow

1. User clicks "Show tree from root" at `/home/user/projects`
2. `sshLite.showTreeFromRoot` command:
   - Marks connection as tree-from-root mode
   - Stores original path (`/home/user/projects`)
   - Loads ancestor dirs (`/`, `/home`, `/home/user`) into cache
   - Sets `currentPath = '/'` and populates expand paths
3. Tree renders from `/` with path segments auto-expanded down to `projects/`
4. Already-cached current directory contents are reused
5. User clicks "Back to flat view" → restores original path and exits mode

#### Auto-Expand

In `getChildren()` and `buildDirectoryItems()`, directories on the expand path are returned with `CollapsibleState.Expanded`:

```typescript
const autoExpandPaths = this.treeFromRootExpandPaths.get(connectionId);
const shouldAutoExpand = file.isDirectory && autoExpandPaths?.has(file.path);
const state = shouldAutoExpand ? Expanded : Collapsed;
```

#### Mode Exit

Tree-from-root mode automatically exits when the user explicitly navigates via `goToPath` (clicking a folder to enter flat view).

---

### Smart Reveal (Preserve Tree State)

`revealFile()` expands the tree from the current view to the target file **without collapsing or resetting** the existing tree state.

#### Case A: File Under currentPath

File is reachable from the current view (e.g., currentPath = `/home/user`, file = `/home/user/projects/src/foo.ts`):
- Do NOT change `currentPath` — tree stays exactly as-is
- `loadIntermediateDirs()` caches all directories between currentPath and file's parent
- VS Code's `reveal()` uses `getParent()` to trace back and auto-expand each level

#### Case B: File Outside currentPath

File is not under current view (e.g., currentPath = `/home/user/projects`, file = `/var/log/syslog`):
- Switch to tree-from-root mode (reuses Change 7 infrastructure)
- `revealViaTreeFromRoot()` loads ancestors for BOTH paths (original + target)
- Both paths are auto-expanded so user's context is preserved alongside the revealed file
- `reveal()` selects the target file

#### Key Methods

```typescript
private async loadIntermediateDirs(connection, fromPath, toPath): Promise<void>
// Loads all dirs between fromPath and toPath into cache

private async revealViaTreeFromRoot(connection, originalPath, remotePath): Promise<void>
// Enables tree-from-root, loads ancestors for both paths, sets expand paths
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

Provides badges and colors for file tabs and tree items.

### Badge Types

| Badge | Color | Meaning | Source |
|-------|-------|---------|--------|
| `↑` | Orange (`charts.orange`) | File uploading | `FileService.uploadingFiles` Set |
| `✗` | Red (`errorForeground`) | Upload failed | `FileService.failedUploadFiles` Set |
| `M` | Yellow (`gitDecoration.modifiedResourceForeground`) | File modified | Change tracking |
| — | Blue | Filtered folder | Filename filter active |
| — | Gray | Empty after filter | No matching files in folder |

### Event Subscriptions

```typescript
constructor(fileService: FileService, connectionManager: ConnectionManager) {
  // Subscribe to upload state changes
  fileService.onUploadStateChanged(() => this.refresh());

  // Subscribe to connection changes (clear decorations on disconnect)
  connectionManager.onDidChangeConnections(() => this.refresh());
}
```

### Implementation Pattern

```typescript
provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
  const localPath = normalizeLocalPath(uri.fsPath);

  // Check upload state
  if (fileService.isUploading(localPath)) {
    return { badge: '↑', color: new vscode.ThemeColor('charts.orange') };
  }
  if (fileService.isUploadFailed(localPath)) {
    return { badge: '✗', color: new vscode.ThemeColor('errorForeground') };
  }

  // Check modified state
  if (fileService.isModified(localPath)) {
    return { badge: 'M', color: ... };
  }

  return undefined;  // No decoration for non-SSH files
}
```

**Critical**: Uses `normalizeLocalPath(uri.fsPath)` for Windows drive letter normalization. Without this, Map lookups fail.
