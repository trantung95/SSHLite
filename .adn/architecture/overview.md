# Architecture Overview

SSH Lite (SSH Tools) is a VS Code extension that provides SSH/SFTP file browsing, editing, terminal, search, and a suite of remote-admin utilities (processes, services, snippets, keys, cron, diff, batch runner) **without** installing a VS Code server on remote machines. Built with TypeScript, it uses the `ssh2` library for SSH/SFTP operations and VS Code's extension API for UI.

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
│  PriorityQueueService  RemoteClipboardService     │
│  SnippetService  SshKeyService                    │
│  SystemToolsService  RemoteDiffService            │
│  AiActivityWatchService  BeaconService            │
│  HousekeepingService                             │
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

HousekeepingService
  ├─ uses: FileService (registerCleanupHook → rides hourly timer; cleanupOldTempFiles)
  └─ removes: orphaned sshlite-diff-* temp dirs (safety net for RemoteDiffService)

AiActivityWatchService
  └─ feeds: SupportViewProvider (named AI-tool activity → {type:'aiActive'})

BeaconService
  └─ feeds: SupportViewProvider (cross-window activity pulse)
```

---

## Key Design Decisions

### Why no VS Code Server?
Unlike Remote-SSH, SSH Lite uses pure SSH/SFTP for all operations. This means:
- Works on any SSH-enabled server (no install required)
- Minimal server footprint
- Works behind firewalls/restricted environments
- Trade-off: No IntelliSense, no remote debugging, no extension forwarding

### Extension host model (v0.8.17+)

`package.json` declares `"extensionKind": ["ui", "workspace"]`. VS Code prefers the first entry, so the placement is:

- **Local install (default)**: in a regular VS Code window AND in a Remote-SSH session, SSH Lite is installed on the local **UI extension host** (the user's own machine). SSH connections originate from the user's machine; downloads land on the local filesystem; port forwards bind to the user's machine. When VS Code is connected to a Remote-SSH workspace, the Marketplace shows an **Install in Local** button — the same UX as the PDF Viewer and other UI-first extensions.
- **Workspace install (advanced)**: the user can explicitly install SSH Lite on the workspace host when they want to use SSH Lite *from* a remote Linux server to a third machine (chained SSH). In this mode every file dialog (`showOpenDialog` / `showSaveDialog`) is served by the remote, so it browses the **server's** filesystem — downloads land on the workspace host and the upload picker shows server files, not the user's machine. SSH Lite shows a one-time hint on activation (covering both downloads and uploads) and, for uploads specifically, a point-of-action warning before opening the server-only picker — both suggest **Install in Local** and are suppressible via `sshLite.suppressLocalInstallHint`.

All file I/O on dialog URIs goes through `vscode.workspace.fs` (not raw Node `fs`), so URI schemes other than `file:` — notably `vscode-remote:` and any registered `FileSystemProvider` — are handled correctly, on both the **write** side (downloads: `writeUserSelectedUri`, v0.8.17) and the **read** side (uploads: `readUserSelectedUri`, v0.8.18). The `vscode.Uri.joinPath` helper builds child URIs inside folder dialog results, preserving the scheme, and `decodeUriComponentSafe` (in `utils/helpers.ts`) decodes leaf names without throwing on a literal `%`. See `.adn/lessons.md` "2026-05-22" and "2026-06-01" for the bugs that motivated this.

**Edge case — port forwarding scope**: when SSH Lite runs on UI host inside a Remote-SSH window, the forwarded port lives on the user's machine, not the remote workspace. Tools running inside the Remote-SSH workspace (e.g., `curl` in the Remote-SSH terminal) cannot reach that port. For workspace-side access, either use VS Code's built-in Remote-SSH port forwarding, or install SSH Lite a second time on the workspace host.

### Why singletons instead of dependency injection?
VS Code extensions have a single activation point (`activate()`). Singletons keep the architecture simple and allow any component to access services without passing references through constructors. The trade-off is testing complexity (need to reset singletons between tests).

### Why CommandGuard?
Centralizes activity tracking so the Activity panel shows a consistent, unified view of all operations. Without it, each service would need its own tracking logic.

### Why event-driven instead of direct calls?
Decouples services from UI. FileService doesn't know about FileTreeProvider — it just fires events. This allows multiple consumers to react (decoration provider, tree provider, status bar) without the service knowing about them.

### Housekeeping rides an existing timer (no new polling loop)

`HousekeepingService` (since v0.9.1) sweeps stale junk, that is orphaned `sshlite-diff-*` temp directories from the "Diff with Local" feature older than `sshLite.diffTempRetentionHours` (default 24), once at activation, then on every tick of FileService's existing hourly temp-file cleanup timer via a new `FileService.registerCleanupHook(cb)`. This adds a cleanup behaviour without adding a second `setInterval` (LITE: no new polling). The root cause is also fixed upstream: `RemoteDiffService` now tracks its temp directories and removes them when the diff tab closes (and all remaining ones on dispose); the housekeeping sweep is the safety net for any left behind by a crash or abrupt shutdown. See `.adn/CHANGELOG.md` v0.9.1.

### Webview build pipeline (since v0.8.1)

The search panel webview (`src/webviews/SearchPanel.ts`) loads its HTML/CSS/JS from `media/search/`, bundled by esbuild from `webview-src/search/`. The pipeline:

```
webview-src/search/
  index.ts ──┐
  index.html ─┼─▶ build/build-webview.js (esbuild) ─▶ media/search/{main.js, main.css, index.html}
  styles.css ─┘
```

`npm run compile` chains `compile:webview` → `tsc`. `npm run watch:webview` for dev iteration. `npm run verify:package` is the smoke test that the bundle ships in the .vsix.

The webview loads bundled assets via `webview.asWebviewUri()` with a per-load CSP nonce; no inline scripts.
