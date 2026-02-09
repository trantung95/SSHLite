# Extension Activation Flow

Step-by-step activation sequence when VS Code loads SSH Lite (`src/extension.ts`).

---

## Activation Trigger

```json
// package.json
"activationEvents": ["onStartupFinished"]
```

Extension activates after VS Code finishes loading (non-blocking).

---

## Activation Sequence

### Phase 1: Initialize Output Channel

```typescript
outputChannel = vscode.window.createOutputChannel('SSH Lite');
log('SSH Lite extension activating...');
```

### Phase 2: Get Singleton Service Instances

```typescript
const connectionManager = ConnectionManager.getInstance();
const hostService = HostService.getInstance();
const fileService = FileService.getInstance();
const terminalService = TerminalService.getInstance();
const portForwardService = PortForwardService.getInstance();
const credentialService = CredentialService.getInstance();
const auditService = AuditService.getInstance();
const monitorService = ServerMonitorService.getInstance();
```

### Phase 3: Initialize Services (ORDER MATTERS)

```typescript
// 1. MUST be first — needs ExtensionContext for SecretStorage
credentialService.initialize(context);

// 2. Host key verification — needs globalState
setGlobalState(context.globalState);

// 3. Folder history — needs ExtensionContext for persistence
const folderHistoryService = FolderHistoryService.getInstance();
folderHistoryService.initialize(context);
```

**Critical**: `credentialService.initialize()` MUST be called before any connection attempt. Without it, SecretStorage is null and credential operations silently fail.

### Phase 4: Set Extension Paths

```typescript
setExtensionPath(context.extensionPath);       // HostTreeProvider custom icons
setFileTreeExtensionPath(context.extensionPath); // FileTreeProvider custom icons
```

### Phase 5: Create Tree Providers

```typescript
const hostTreeProvider = new HostTreeProvider();
const fileTreeProvider = new FileTreeProvider();
const portForwardTreeProvider = new PortForwardTreeProvider();
const activityTreeProvider = new ActivityTreeProvider();
const activityService = ActivityService.getInstance();
```

**Note**: Tree providers are NOT singletons — they're instantiated here. Services ARE singletons.

### Phase 6: Initialize Progressive Download

```typescript
const progressiveContentProvider = ProgressiveFileContentProvider.getInstance();
const progressiveDownloadManager = ProgressiveDownloadManager.getInstance();
progressiveDownloadManager.initialize(progressiveContentProvider);

// Register custom URI scheme for preview content
context.subscriptions.push(
  vscode.workspace.registerTextDocumentContentProvider(
    PROGRESSIVE_PREVIEW_SCHEME,  // 'ssh-lite-preview'
    progressiveContentProvider
  )
);
```

### Phase 7: Register Tree Views

```typescript
const hostTreeView = vscode.window.createTreeView('sshLite.hosts', {
  treeDataProvider: hostTreeProvider,
  showCollapseAll: false,  // Custom 3-state toggle buttons instead
});

const fileTreeView = vscode.window.createTreeView('sshLite.fileExplorer', {
  treeDataProvider: fileTreeProvider,
  showCollapseAll: false,
  dragAndDropController: fileTreeProvider,  // Drag & drop support
  canSelectMany: true,                      // Multi-select
});

// ... portForwardTreeView, activityTreeView similar
```

### Phase 8: Wire Up Providers with Services

```typescript
// Port forward service ↔ tree provider
portForwardService.setTreeProvider(portForwardTreeProvider);

// File decoration provider
const fileDecorationProvider = new SSHFileDecorationProvider(fileService, connectionManager);
context.subscriptions.push(
  vscode.window.registerFileDecorationProvider(fileDecorationProvider)
);

// Filename filter auto-clear callback
fileTreeProvider.setOnFilterCleared(() => {
  fileDecorationProvider.clearFilteredFolder();
  setContext('sshLite.hasFilenameFilter', false);
});
```

### Phase 9: Initialize Context Keys

```typescript
// 3-state expand/collapse (all start collapsed = state 0)
setContext('sshLite.hosts.expandState', 0);
setContext('sshLite.fileExplorer.expandState', 0);
setContext('sshLite.activity.expandState', 0);
setContext('sshLite.portForwards.expandState', 0);
```

### Phase 10: Register Commands (80+)

```typescript
const commands = [
  vscode.commands.registerCommand('sshLite.connect', async (item?) => { ... }),
  vscode.commands.registerCommand('sshLite.disconnect', async (item?) => { ... }),
  // ... 80+ more commands
];
context.subscriptions.push(...commands);
```

### Phase 11: Wire Up Event Listeners

```typescript
// Connection changes → refresh trees + update search panel
connectionManager.onDidChangeConnections(() => {
  hostTreeProvider.refresh();
  fileTreeProvider.refresh();
  // Update search panel server states
});

// Connection state → clear cache on disconnect
connectionManager.onConnectionStateChange((event) => {
  if (event.state === ConnectionState.Disconnected) {
    fileTreeProvider.clearCache(event.connection.id);
  }
});

// Track tree expansion for state preservation
fileTreeView.onDidExpandElement((e) => {
  fileTreeProvider.trackExpand(e.element);
});
```

### Phase 12: Post-Activation Tasks

```typescript
// Force initial refresh (clears cached icons from previous session)
setTimeout(() => hostTreeProvider.refresh(), 100);

// Detect orphaned SSH files (from previous VS Code session)
setTimeout(detectOrphanedSshFiles, 1000);

// Create status bar items
const preloadStatusBar = vscode.window.createStatusBarItem(...);
const sshFileInfoStatusBar = vscode.window.createStatusBarItem(...);
```

---

## Command Handler Pattern

All 80+ commands follow this pattern:

```typescript
vscode.commands.registerCommand('sshLite.commandName', async (item?) => {
  try {
    // 1. Determine target (from tree item or quick pick)
    // Tree items come from context menu; command palette passes undefined
    let connection: SSHConnection;
    if (item instanceof FileTreeItem) {
      connection = item.connection;
    } else {
      connection = await selectConnection(connectionManager);
    }
    if (!connection) return;

    // 2. Perform operation
    await fileService.doSomething(connection, ...);

    // 3. Update UI
    fileTreeProvider.refresh();
    vscode.window.setStatusBarMessage('$(check) Done', 3000);
  } catch (error) {
    const errMsg = (error as Error).message;
    vscode.window.showErrorMessage(`Failed: ${errMsg}`);
  }
});
```

**Important**: Commands receive different arguments based on invocation:
- From tree context menu: receives the `TreeItem` instance
- From command palette: receives `undefined` — must prompt user
- From inline icon: receives the `TreeItem`

Commands must handle all cases.
