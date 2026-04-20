# Extension Activation Flow

Activation sequence in `src/extension.ts`. Trigger: `onStartupFinished` (non-blocking).

## Phases

### Phase 1: Output Channel
Create `SSH Lite` output channel, log activation start.

### Phase 2: Get Singleton Instances
All 8 services: `ConnectionManager`, `HostService`, `FileService`, `TerminalService`, `PortForwardService`, `CredentialService`, `AuditService`, `ServerMonitorService`.

### Phase 3: Initialize Services (ORDER MATTERS)
1. `credentialService.initialize(context)` — **MUST be first** (needs SecretStorage)
2. `setGlobalState(context.globalState)` — host key verification
3. `folderHistoryService.initialize(context)` — persistence

**Critical**: Without `credentialService.initialize()`, SecretStorage is null and credential ops silently fail.

### Phase 4: Extension Paths
`setExtensionPath()` + `setFileTreeExtensionPath()` for custom icons.

### Phase 5: Create Tree Providers
`HostTreeProvider`, `FileTreeProvider`, `PortForwardTreeProvider`, `ActivityTreeProvider` — instantiated (NOT singletons). Also get `ActivityService.getInstance()`.

### Phase 6: Progressive Download
`ProgressiveDownloadManager.initialize(contentProvider)`. Register `ssh-lite-preview` URI scheme.

### Phase 7: Register Tree Views
4 views: `sshLite.hosts`, `sshLite.fileExplorer` (+ drag/drop, multi-select), port forwards, activity. All with `showCollapseAll: false` (custom 3-state toggle).

### Phase 8: Wire Providers ↔ Services
- `portForwardService.setTreeProvider(treeProvider)`
- Register `FileDecorationProvider(fileService, connectionManager)`
- Set filename filter auto-clear callback

### Phase 9: Context Keys
Initialize 4 expand states to 0 (collapsed).

### Phase 10: Register Commands (80+)
All commands push to `context.subscriptions`.

### Phase 11: Event Listeners
- `onDidChangeConnections` → refresh hosts + files + search panel
- `onConnectionStateChange` → clear file cache on disconnect
- `onDidExpandElement` / `onDidCollapseElement` → track expansion

### Phase 12: Post-Activation
- Delayed `hostTreeProvider.refresh()` (100ms) — clears stale icons
- Delayed `detectOrphanedSshFiles()` (1s)
- Create status bar items

## Command Handler Pattern

All 80+ commands: determine target (TreeItem from context menu or `selectConnection()` from palette) → perform operation → update UI → catch errors. Must handle both tree item and `undefined` (command palette) invocation.
