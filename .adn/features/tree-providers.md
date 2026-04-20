# Tree Providers

Covers `HostTreeProvider`, `FileTreeProvider`, and `FileDecorationProvider`.

---

## HostTreeProvider (`src/providers/HostTreeProvider.ts`)

### Tree Hierarchy

```
sshLite.hosts → ServerTreeItem → UserCredentialTreeItem → PinnedFolderTreeItem
                                                        └─ AddCredentialTreeItem
```

### contextValues

| Class | contextValue | When Shown |
|-------|-------------|------------|
| ServerTreeItem | `server`, `savedServer`, `connectedServer.saved` | Always |
| UserCredentialTreeItem | `credential`, `credentialConnected` | Under servers |
| PinnedFolderTreeItem | `pinnedFolder`, `pinnedFolderConnected` | Under credentials |
| AddCredentialTreeItem | `addCredential` | Under servers |

**Critical**: `when` clauses use regex: `viewItem =~ /^connectedServer/`. Dot escaped as `\\.`.

### Host Filter

`sshLite.filterHosts` → pattern → matches name/host/username. Glob support. Context key: `sshLite.hasHostFilter`.

### Icons & Connection State

| State | Icon | Color |
|-------|------|-------|
| Connected | `vm-running` | Green |
| Last failed | `vm-outline` | Orange (rich tooltip with error + time ago) |
| Saved | `vm` | Gray |
| SSH config only | `vm-outline` | Gray |

Failed connection stored via `connectionManager.saveLastConnectionAttempt()` in globalState. Cleared on successful reconnect.

---

## FileTreeProvider (`src/providers/FileTreeProvider.ts`)

### Tree Hierarchy

```
sshLite.fileExplorer → ConnectionTreeItem → ParentFolderTreeItem (..)
                                          → FileTreeItem (recursive)
```

### Caching

`fileCache: Map<string, CacheEntry>` — key: `${connectionId}:${remotePath}`, TTL: `treeRefreshIntervalSeconds` (default 10s). Cleared on disconnect/refresh/filter change.

### Filter System

**Content Filter** (`sshLite.filterFiles`): grep file contents on server, flat list, limit `filterMaxResults`.

**Filename Filter** (`sshLite.filterFileNames`): filter by name, glob/substring, multiple simultaneous filters on different folders. Three modes:

| Mode | Files | Directories |
|------|-------|-------------|
| `files` (default) | Filtered | Always shown |
| `folders` | Always shown | Filtered |
| `both` | Filtered | Filtered |

State: `activeFilters: Map<"connId:basePath", ActiveFilter>` where `ActiveFilter` = `{ pattern, basePath, connectionId, highlightedPaths, matchCounts, filterMode }`.

Key behaviors:
- Match counts: walk parent paths from results to basePath, shown as `(N)` in description
- Empty folders after filter grayed out via `isEmptyAfterFilter()`
- Connection contextValue: `connection` → `connection.filtered` when active
- QuickPick: text input + 3 mode items (files/folders/both)
- Selective clear: inline per-folder or toolbar for all
- Reveal auto-clear: `sshLite.revealInTree` clears blocking filters

### Connection Change Refresh

Compares current vs `lastKnownConnectionIds`. Structural change → full refresh. No change → targeted `refreshConnection(id)`. Preserves expansion state.

### Show Tree From Root

Inline button on `..` row → navigates to `/` with auto-expand down to current path. Builds expand paths, loads ancestors into cache, sets `currentPath = '/'`. `pendingAutoExpandPaths` consumed once by `getChildren()`, cleared after 500ms.

### Smart Reveal

`revealFile()` expands tree to target without resetting state:
- **Under currentPath**: Load intermediate dirs, use VS Code's `reveal()` + `getParent()` chain
- **Outside currentPath**: Navigate to root, load ancestors for both paths, queue both + expanded folders as auto-expand

### 3-State Expand/Collapse Toggle

State 0 (collapsed) → 1 (fully expanded) → 2 (first level only) → 0. Context key: `sshLite.fileExplorer.expandState`.

### Tree Item Properties

`FileTreeItem`: `file`, `connection`, `shouldBeExpanded`, `isOpenInTab`, `isHighlighted`, `isLoading`, `isFiltered`, `isEmptyAfterFilter`. Drag & drop via `dragAndDropController`, `canSelectMany: true`.

---

## FileDecorationProvider (`src/providers/FileDecorationProvider.ts`)

### Badge Types

| Badge | Color | Meaning | Source |
|-------|-------|---------|--------|
| `↑` | Yellow | Uploading | `FileService.uploadingFiles` |
| `✗` | Red | Upload failed | `FileService.failedUploadFiles` |
| `F` | Blue | Filtered folder | Filename filter active |
| — | Gray | Empty after filter / disconnected | No matches or lost connection |

### Multi-Filter State

Three additive Sets: `filteredFolderUris` (blue F), `filterHighlightedUris` (not grayed), `filterBasePrefixes` (gray check). `rebuildFilterState()` replaces all atomically from FileTreeProvider.

### Implementation

`provideFileDecoration(uri)`:
- `ssh://` URIs: filtered folder badges + empty folder graying
- `file://` URIs: upload state + connection state decorations

**Critical**: Uses `normalizeLocalPath(uri.fsPath)` for Windows drive letter normalization.

Subscribes to: `fileService.onFileMappingsChanged`, `onUploadStateChanged`, `connectionManager.onDidChangeConnections`, `onConnectionStateChange`.
