# Architecture Overview

SSH Lite is a VS Code extension that provides SSH/SFTP file browsing, editing, terminal, and search capabilities **without** installing a VS Code server on remote machines. Built with TypeScript, it uses the `ssh2` library for SSH/SFTP operations and VS Code's extension API for UI.

---

## Technology Stack

- **Runtime**: VS Code Extension (Node.js)
- **Language**: TypeScript (ES2022 target, CommonJS modules)
- **SSH Library**: `ssh2` (Client, SFTPWrapper, ClientChannel)
- **SSH Config**: `ssh-config` (parsing ~/.ssh/config)
- **Testing**: Jest + mocked VS Code API
- **Packaging**: `vsce` (VS Code Extension CLI)
- **VS Code API**: `^1.85.0`

---

## System Layers

```
┌─────────────────────────────────────────────────┐
│                   VS Code UI                     │
│  (Tree Views, Editors, Terminals, Status Bar)    │
├─────────────────────────────────────────────────┤
│              Webviews                            │
│  SearchPanel (HTML/JS ↔ extension messaging)     │
├─────────────────────────────────────────────────┤
│           Tree Providers (instantiated)           │
│  HostTreeProvider    FileTreeProvider             │
│  ActivityTreeProvider  PortForwardTreeProvider    │
│  FileDecorationProvider                          │
├─────────────────────────────────────────────────┤
│         extension.ts (activation + wiring)        │
│  Command registration (80+), event listeners,    │
│  provider ↔ service wiring, context management   │
├─────────────────────────────────────────────────┤
│            Services (singletons)                  │
│  ConnectionManager  FileService  CredentialService│
│  HostService  ActivityService  AuditService       │
│  TerminalService  PortForwardService             │
│  ServerMonitorService  FolderHistoryService       │
│  CommandGuard  ProgressiveDownloadManager         │
│  PriorityQueueService                            │
├─────────────────────────────────────────────────┤
│         Connection Layer                          │
│  SSHConnection (ssh2 Client + SFTPWrapper)        │
│  Host key verification, capability detection      │
├─────────────────────────────────────────────────┤
│              Remote Server (SSH/SFTP)             │
└─────────────────────────────────────────────────┘
```

---

## Key Architectural Patterns

### 1. Singleton Services

All services use the singleton pattern with `getInstance()`:

```typescript
export class FileService {
  private static _instance: FileService;
  private constructor() { }

  static getInstance(): FileService {
    if (!FileService._instance) {
      FileService._instance = new FileService();
    }
    return FileService._instance;
  }
}
```

**Why singletons**: VS Code extension has a single activation context. Services maintain shared state (connections, file mappings, credentials) that must be consistent across all commands and providers.

**Initialization order matters**:
1. `CredentialService.initialize(context)` — MUST be first (needs ExtensionContext for SecretStorage)
2. `setGlobalState(context.globalState)` — Host key verification storage
3. `FolderHistoryService.initialize(context)` — Preloading history
4. Tree providers created AFTER services initialized
5. `ProgressiveDownloadManager.initialize(contentProvider)` — Large file handling

### 2. Event-Driven Communication

Services and providers communicate via VS Code `EventEmitter`:

```typescript
// Service declares event
private readonly _onUploadStateChanged = new vscode.EventEmitter<string>();
public readonly onUploadStateChanged = this._onUploadStateChanged.event;

// Provider subscribes in extension.ts
fileService.onUploadStateChanged((localPath) => {
  fileDecorationProvider.refresh();
});
```

**Flow**: Service fires event → extension.ts wiring → Provider refreshes UI

### 3. CommandGuard (Man-in-the-Middle)

All significant SSH operations go through `CommandGuard` for unified activity tracking:

```typescript
// WRONG - bypasses tracking
const data = await connection.readFile('/etc/hosts');

// CORRECT - tracked in Activity panel
const data = await commandGuard.readFile(connection, '/etc/hosts');
```

**LITE Principle**: Only user-initiated operations are tracked. Quick metadata lookups (stat, realpath) go directly to SSHConnection.

### 4. Tree Item Identity

Tree items use stable `id` fields that do NOT include dynamic state:

```typescript
// WRONG - expansion state lost on connection change
this.id = `server:${serverKey}:${isConnected}`;

// CORRECT - stable ID preserves expansion
this.id = `server:${serverKey}`;
```

VS Code uses tree item `id` to track expansion state. Changing `id` resets the tree.

### 5. Context Values and Menu System

Tree items set `contextValue` which controls menu visibility via package.json `when` clauses:

```typescript
// Tree item
this.contextValue = 'connectedServer.saved';

// package.json menu
"when": "viewItem =~ /^connectedServer/"  // Regex match
```

The `=~` operator does regex matching, so `connectedServer.saved` matches `/^connectedServer/`.

---

## VS Code API Patterns Used

| API | Usage |
|-----|-------|
| `TreeDataProvider` | HostTreeProvider, FileTreeProvider, ActivityTreeProvider, PortForwardTreeProvider |
| `FileDecorationProvider` | Upload badges (↑/✗), modified badge (M), filter decorations |
| `TextDocumentContentProvider` | Progressive download preview (custom URI scheme) |
| `WebviewPanel` | SearchPanel (cross-server search UI) |
| `SecretStorage` | Credential passwords/keys (OS keychain) |
| `Memento` (globalState) | Host key fingerprints, search sort order, persisted settings |
| `OutputChannel` | "SSH Lite" log channel |
| `StatusBarItem` | Preload progress, SSH file info |
| `EventEmitter` | Service ↔ provider communication |

---

## Service Dependency Map

```
ConnectionManager
  ├─ uses: CredentialService (stored credentials for reconnect)
  ├─ uses: ActivityService (connection activity tracking)
  └─ creates: SSHConnection instances

FileService
  ├─ uses: ConnectionManager (get connections)
  ├─ uses: AuditService (log operations)
  ├─ uses: FolderHistoryService (preloading history)
  ├─ uses: ProgressiveDownloadManager (large files)
  ├─ uses: PriorityQueueService (preload queue)
  └─ uses: CommandGuard (activity tracking)

CommandGuard
  └─ uses: ActivityService (start/complete/fail activities)

SearchPanel
  ├─ uses: ConnectionManager (execute search commands)
  └─ uses: CommandGuard (tracked search operations)

HostTreeProvider
  ├─ uses: HostService (get hosts)
  ├─ uses: ConnectionManager (connection states)
  └─ uses: CredentialService (credentials + pinned folders)

FileTreeProvider
  ├─ uses: ConnectionManager (get connections)
  ├─ uses: FileService (file mappings, upload state)
  └─ uses: CommandGuard (list files)
```

---

## Key Design Decisions

### Why no VS Code Server?
Unlike Remote-SSH, SSH Lite uses pure SSH/SFTP for all operations. This means:
- Works on any SSH-enabled server (no install required)
- Minimal server footprint
- Works behind firewalls/restricted environments
- Trade-off: No IntelliSense, no remote debugging, no extension forwarding

### Why singletons instead of dependency injection?
VS Code extensions have a single activation point (`activate()`). Singletons keep the architecture simple and allow any component to access services without passing references through constructors. The trade-off is testing complexity (need to reset singletons between tests).

### Why CommandGuard?
Centralizes activity tracking so the Activity panel shows a consistent, unified view of all operations. Without it, each service would need its own tracking logic.

### Why event-driven instead of direct calls?
Decouples services from UI. FileService doesn't know about FileTreeProvider — it just fires events. This allows multiple consumers to react (decoration provider, tree provider, status bar) without the service knowing about them.
