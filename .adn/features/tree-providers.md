# Tree Providers

Covers `HostTreeProvider`, `FileTreeProvider`, `PortForwardTreeProvider`, and `FileDecorationProvider`.

> Note: the `sshLite.support` view (top of the container) is **not** a
> `TreeDataProvider` — it is a `WebviewViewProvider` (`SupportViewProvider`).
> A tree row can only show a ~16px icon; the support section needs an animated
> image, so it is HTML. See `features/support-view.md`.

---

## HostTreeProvider (`src/providers/HostTreeProvider.ts`)

The view is titled **Hosts** (not "Secure Shell (SSH) Hosts") because it holds both Secure Shell (SSH) and File Transfer Protocol (FTP) hosts.

### Tree Hierarchy

Grouped (tree) mode, the default:

```
sshLite.hosts → ProtocolGroupTreeItem (SSH / FTP) → ServerTreeItem → UserCredentialTreeItem → PinnedFolderTreeItem
                                                                                            └─ AddCredentialTreeItem
```

When there are no hosts, either view mode instead shows:

```
sshLite.hosts → NoHostsTreeItem ("No SSH hosts yet")
```

Flat (list) mode skips the protocol layer:

```
sshLite.hosts → ServerTreeItem → UserCredentialTreeItem → PinnedFolderTreeItem
                                                        └─ AddCredentialTreeItem
```

### View mode: grouped by protocol vs flat (issue #9)

When at least one host exists, the root either shows two **ProtocolGroupTreeItem** nodes ("SSH" and "FTP") with servers nested underneath, or a flat list of all servers. The empty root uses `NoHostsTreeItem` instead of empty protocol groups. A host with no explicit `connectionType` counts as SSH (backward compatibility).

- Toggle: view-title buttons `sshLite.hostsViewAsList` (shown when grouped) and `sshLite.hostsViewAsTree` (shown when flat), gated by the context key `sshLite.hostsGrouped`.
- The choice is persisted in `globalState` under `sshLite.hostsGrouped` (default `true`) and restored at activation, which also seeds the context key. `HostTreeProvider.setGrouped()` / `isGrouped()` hold the in-memory flag; `getServerItems(protocol?)` filters hosts to a protocol for each group.

### contextValues

| Class | contextValue | When Shown |
|-------|-------------|------------|
| NoHostsTreeItem | `noHosts` | Root when no hosts exist |
| ProtocolGroupTreeItem | `protocolGroup` | Root, grouped mode only (SSH/FTP) |
| ServerTreeItem | `server`, `savedServer`, `connectedServer`, `connectedServer.ftp`, `connectedServer.saved`, `connectedServer.ftp.saved`, `connectedServer.sudo`, `connectedServer.saved.sudo`, `reconnectingServer`, `reconnectingServer.saved` | Always |
| UserCredentialTreeItem | `credential`, `credentialConnected` | Under servers |
| PinnedFolderTreeItem | `pinnedFolder`, `pinnedFolderConnected` | Under credentials |
| AddCredentialTreeItem | `addCredential` | Under servers |

**Critical**: `when` clauses use regex: `viewItem =~ /^connectedServer/`. Dot escaped as `\\.`.

### Host Filter

`sshLite.filterHosts` → pattern → matches name/host/username. Glob support. Context key: `sshLite.hasHostFilter`.

### Icons & Connection State

Host rows keep the `server` icon as their stable identity. Color supplements, never replaces, state text in the tooltip. Secure Shell protocol groups use `remote`; File Transfer Protocol groups use `cloud`.

| State | Icon | Color | Tooltip state |
|-------|------|-------|---------------|
| Connected | `server` | `charts.green` | `Status: Connected` |
| Reconnecting | `server` | `charts.yellow` | `Status: Reconnecting` |
| Connection failed | `server` | `charts.orange` | `Status: Connection failed`, error, and relative attempt time |
| Saved or disconnected | `server` | Default foreground | `Status: Disconnected` |
| Sudo mode | `shield` | `charts.yellow` | `Status: Connected` |
| No hosts | `server` | Default foreground | `No SSH hosts yet` — `Use Add Host to create or import a connection` |

Failed connection stored via `connectionManager.saveLastConnectionAttempt()` in globalState. Cleared on successful reconnect.

---

## PortForwardTreeProvider (`src/providers/PortForwardTreeProvider.ts`)

The root contains one expanded `PortForwardServerGroupTreeItem` per server with an active or saved rule. Active rows appear first, followed by inactive saved rows. With no rules, one non-action `No port forwards` row makes the empty state explicit. Server groups use stable identifiers so the shared expand and collapse controls operate on meaningful structure. One snapshot is shared by root and child reads until `refresh()` invalidates it, avoiding repeated all-host rebuilds while groups are expanded. The provider subscribes to `HostService.onDidChangeHosts`, so host rename, removal, import, and Secure Shell configuration invalidation refresh cached host metadata immediately; both host and connection subscriptions are released by `dispose()`.

Saved orphan rules remain grouped under their original host identifier when the host no longer exists in `HostService`. Saved-row descriptions distinguish `Saved · stopped`, `Host disconnected`, `Port forwarding unavailable`, and `Restore failed · reason`; a same-identifier connection is considered available only when its capability map supports port forwarding. Saved row identifiers use structured tuple encoding so Internet Protocol version 6 host identifiers and colon-bearing legacy rule identifiers cannot collide. Active and saved action counts remain one and two respectively. Full persistence and lifecycle details live in `features/terminal-port-forwarding.md`.

---

## FileTreeProvider (`src/providers/FileTreeProvider.ts`)

### Tree Hierarchy

```
sshLite.fileExplorer → ConnectionTreeItem → ParentFolderTreeItem (..)
                                          → FileTreeItem (recursive)
```

### Caching

`fileCache: Map<string, CacheEntry>` — key: `${connectionId}:${remotePath}`, TTL: `treeRefreshIntervalSeconds` (default 10s). Cleared on disconnect/refresh/filter change.

### Failed Load Handling (issue #13)

`failedLoads: Map<string, string>` — key: `${connectionId}:${remotePath}`, value: error message. When a background directory listing fails, `loadDirectoryAndRefresh()` records the failure **before** firing the tree refresh. The re-entered `getChildren()` renders a `LoadErrorTreeItem` (contextValue `loadError`, id `loadError:${key}`) instead of starting the load again. Without this, a failing directory caused an infinite load → fail → notify → refresh → load loop that froze VS Code and spammed "Failed to list directory" notifications.

Failures are cleared (allowing a retry) only on explicit user actions: `retryFailedLoads()` (the title-bar refresh), `refreshItem()`, `refreshFolder()`, `setCurrentPath()` (navigation), `clearCache()` (reconnect), and `dispose()`. For failed paths with cached rows, `retryFailedLoads()` queues a replacement load before clearing the error so connection roots recover without an inline refresh action. The generic `refresh()` only redraws state; filename filter changes use it without listing or searching the server. A successful reload also clears the entry. Regression tests: `FileTreeProvider.issue13.test.ts`.

### Remote Files Presentation States

- **Default:** a connected Secure Shell (SSH) or File Transfer Protocol (FTP) root uses the native `remote` ThemeIcon with a green state color and keeps the account, host, and current path in its description. The parent row keeps `arrow-up` with the Visual Studio Code theme's default foreground.
- **Filtered:** cached rows are filtered immediately without a server call. An explicit Deep Scan calls `searchFiles`; recursive result completeness, `filterMaxResults`, and limit-reached behavior are unchanged. Folder and connection descriptions keep the active pattern and match count.
- **Loading:** a directory with no cached listing uses `sync~spin` and names the path, such as `Loading /var/log...`. Existing cached rows remain visible. If another refresh arrives while the replacement load is active, it stays queued and runs after that load settles so the older response cannot become the final snapshot. A file refresh also uses `sync~spin` and puts the full remote path in the description.
- **Open file:** the row keeps its `file` ThemeIcon and adds `Open` to the description. It does not replace the file type with an eye icon.
- **Failed listing:** `LoadErrorTreeItem` uses `error`, includes the server reason, and directs recovery through the existing refresh action. Other cached directory data remains intact; the provider does not auto-retry or add another inline action.
- **Upload failure:** the remote row and cached server data remain unchanged. `SSHFileDecorationProvider` marks the local editor file with a red failure badge and `FileService` reports the failed save; saving again performs the existing retry flow.
- **Empty folder:** a loaded child directory with no entries returns `[]`, allowing Visual Studio Code to render its native empty tree state without an error-like placeholder or a new action.

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

### Drag & Drop (`handleDrag` / `handleDrop`)

`FileTreeProvider` is its own `TreeDragAndDropController`, registered on the `sshLite.fileExplorer` view. Two payloads are carried on distinct MIME types so a file drag is never confused with a connection reorder:

| MIME type | Source items | Drop behaviour |
|-----------|--------------|----------------|
| `application/vnd.code.tree.sshlite.connection` | `ConnectionTreeItem` | Reorder connections (`connectionOrder`) |
| `application/vnd.code.tree.sshlite.file` | `FileTreeItem` (files **and** folders) | **Move** the dragged item(s) into the drop target (issue #18) |

**File/folder move** (`handleFileDrop`) reuses the exact same `FileService` primitives as cut+paste, so behaviour is identical to a cut followed by a paste:

- **Same host** → `moveRemoteSameHost` (SFTP/FTP `rename`, zero data transfer).
- **Cross host** → `copyRemoteCrossHost` then `deleteRemotePath` on the source (a copy that fails to delete the source warns but keeps the destination).
- **Destination resolution** (`resolveDropDestination`): drop on a folder → into it; on a connection node → into its current folder (resolved absolute); on a file → into the file's parent folder; on `..` → the parent path; on empty space → status-bar hint, no move.
- **Guards**: dropping into the folder the item already lives in is a no-op; moving a folder into itself or a descendant warns and is skipped; name conflicts at the destination use `nextCopyName` (keep both, never overwrite).
- **Feedback** (the original bug was a silent no-op): a cancellable `withProgress` notification during the move, per-item error toasts, a `$(check) Moved …` status message, and a refresh of both the destination and every source folder. All steps log via `infoLog('file-tree-dnd', …)`.

Tests: `FileTreeProvider.test.ts` ("issue #18", mocked wiring/guards) + `src/integration/docker-ssh-dnd-move.test.ts` (real same-host / cross-host / folder move end-to-end).

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

## User Actions

| Action | Primitives | Notes |
|---|---|---|
| Load file tree | listFiles, stat | |
| Reveal in tree | stat, fileExists, listFiles | |
