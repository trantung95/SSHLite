# Extension Activation Flow

Activation sequence in `src/extension.ts`. Trigger: `onStartupFinished` (non-blocking).

## Activation hardening (v0.8.11+)

**Background**: in v0.8.10, an unguarded throw in any single init step aborted the whole `activate()` function before reaching `createTreeView()`. Result: all 4 tree views showed *"There is no data provider registered"* and saved hosts looked lost. v0.8.11 introduces a `safeStep()` wrapper so one failure no longer cascades.

**`safeStep(name, fn)` contract** (top of `src/extension.ts`):

```ts
function safeStep<T>(name: string, fn: () => T): T | undefined
```

- On success: logs `lifecycle / activate/<name>-ok` via `infoLog`, returns the result of `fn()`.
- On throw: pushes `name` onto module-level `_activateFailures: string[]`, logs `lifecycle / activate/<name>-failed { errorName, errorMessage, stack(3 lines) }`, writes a one-liner to the SSH Lite output channel via `log()`, returns `undefined`.

**Wrapped steps** (in order they fire inside `activate()`):

| Step name | What runs |
|-----------|-----------|
| `credential-svc` | `credentialService.initialize(context)` — SecretStorage init |
| `global-state` | `setGlobalState(context.globalState)` — host key store |
| `connection-mgr` | `connectionManager.initialize(context)` — failed-connection indicator |
| `port-forward-svc` | `portForwardService.initialize(context)` — port-forward persistence |
| `folder-history-svc` | `folderHistoryService.initialize(context)` — smart preload history |
| `snippet-svc` | `SnippetService.getInstance().initialize(context)` |
| `host-tree-view` | `vscode.window.createTreeView('sshLite.hosts', …)` |
| `file-tree-view` | `vscode.window.createTreeView('sshLite.fileExplorer', …)` (with drag/drop + multi-select) |
| `port-forward-tree-view` | `vscode.window.createTreeView('sshLite.portForwards', …)` |
| `activity-tree-view` | `vscode.window.createTreeView('sshLite.activity', …)` |

**Tree-provider constructors are NOT wrapped.** Each provider has hundreds of downstream call sites (`fileTreeProvider.refreshFolder(...)` etc.) inside command handlers — making them nullable would require guards across the entire 3300-line activate body. In practice they don't throw; if they ever do, the throw propagates as before. Service inits are where the v0.8.10 bug actually lived, and that's what's now hardened.

**Tree-view variables are `TreeView<T> | undefined`.** Downstream code paths that touch a tree view (5 immediate subscriptions + 3 `.reveal()` calls in command handlers + the bulk expand-all helper + the final `context.subscriptions.push`) check for `undefined` before dereferencing.

**End-of-activate summary** (right before the final `log('SSH Lite extension activated')`):

- If `_activateFailures.length > 0`, fires one `vscode.window.showErrorMessage` listing the failed step names so the user immediately sees which feature is degraded.
- Always emits `infoLog('lifecycle', 'activate/complete', { failedSteps, failedNames })`.

**Reading the log to diagnose an activation problem**:
1. Open Output → SSH Lite.
2. Look for the most recent `lifecycle / activate/*` block. The last `activate/<step>-ok` tells you the last step that ran cleanly; the `activate/<step>-failed` immediately after names the broken step + carries the error message and a short stack.
3. The final `activate/complete` entry lists every failed step at a glance.

**Regression net**: `src/extension.activate.test.ts` — two suites, one happy and one degraded. The degraded suite injects a throw into `CredentialService.prototype.initialize` and asserts the OTHER 3 trees still register, `_activateFailures` contains `'credential-svc'`, and the user gets a single `showErrorMessage` mentioning the step. Future refactors that accidentally move a throw-prone call outside `safeStep` will fail these tests.

**Future activation code MUST go through `safeStep`** unless the work is truly side-effect-free. Adding a new service init? Wrap it. Adding a new `createTreeView`? Wrap it. The diagnostic logging it produces is also free — every step's success or failure is now visible in the output channel by default (no `sshLite.diagnosticLogging` setting required, because these are `infoLog` calls).

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

All 98 commands: determine target (TreeItem from context menu or `selectConnection()` from palette) → perform operation → update UI → catch errors. Must handle both tree item and `undefined` (command palette) invocation.
