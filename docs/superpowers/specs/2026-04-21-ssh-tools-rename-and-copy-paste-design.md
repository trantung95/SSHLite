# SSH Lite → SSH Lite (SSH Tools): Rename + Remote Copy/Paste Design

Date: 2026-04-21
Status: Approved — auto-implementing

## Goals

Two bundled changes shipped together as `v0.6.0`:

1. **Identity refresh** — rebrand from "SSH Lite - Remote File Browser & Terminal" to **"SSH Lite (SSH Tools)"**, positioning the extension as a growing suite of SSH utilities rather than a narrow file-browser.
2. **Core gap: remote copy/paste** — add the most-missed file-management action (copy/cut/paste of remote files and folders, both same-host and cross-host), matching VS Code's native Explorer UX.

## Non-Goals

- The full utility roadmap (Process Viewer, Snippet Library, Key Manager, etc.) is tracked for follow-up phases 3–5. Out of scope for this spec.
- Drag-and-drop support (tracked separately; clipboard pattern first).
- Persisting clipboard across extension reload.

## Phase 1 — Rename + Tags

### package.json changes

| Field | Before | After |
| --- | --- | --- |
| `displayName` | `"SSH Lite - Remote File Browser & Terminal"` | `"SSH Lite (SSH Tools)"` |
| `version` | `"0.5.6"` | `"0.6.0"` |

**New keywords** appended (to position as a "tools suite"):

```
"ssh tools", "ssh utilities", "ssh manager", "ssh suite", "remote tools"
```

No code changes, no test changes for Phase 1.

## Phase 2 — Remote Copy/Paste

### Approach

Clipboard-service pattern (matches VS Code Explorer): right-click Copy/Cut → right-click destination → Paste. Works identically for same-host and cross-host — the clipboard holds a connection reference, not just a path.

### New service: `RemoteClipboardService`

Singleton in `src/services/RemoteClipboardService.ts`. In-memory only — cleared on extension reload.

```typescript
interface ClipboardEntry {
  connectionId: string;
  remotePath: string;
  isDirectory: boolean;
  name: string;
}

interface ClipboardState {
  items: ClipboardEntry[];
  operation: 'copy' | 'cut';
  timestamp: number;
}
```

**Public API:**
- `getInstance()` — singleton accessor
- `setClipboard(items, operation)` — stores, sets `sshLite.hasClipboard` context key, fires `onDidChange`
- `getClipboard(): ClipboardState | null`
- `clear()` — clears state + context key + fires `onDidChange`
- `onDidChange: vscode.Event<void>` — consumers can react (future: visual decoration on cut items)

### New `FileService` methods

```typescript
// Same-host: cp -r <src> <dest> via exec (fast single command)
async copyRemoteSameHost(conn: SSHConnection, srcPath: string, destPath: string, isDirectory: boolean): Promise<void>

// Same-host: mv <src> <dest> via SFTP rename if same FS, else cp + rm
async moveRemoteSameHost(conn: SSHConnection, srcPath: string, destPath: string): Promise<void>

// Cross-host: SFTP read stream → SFTP write stream, recursive for folders
async copyRemoteCrossHost(
  srcConn: SSHConnection,
  srcPath: string,
  destConn: SSHConnection,
  destPath: string,
  isDirectory: boolean,
  progress?: vscode.Progress<{message?: string; increment?: number}>,
  token?: vscode.CancellationToken
): Promise<void>
```

Uses existing `CommandGuard` + `auditService` + `handlePermissionDenied` sudo fallback patterns.

### New commands

| Command | Title | Target |
| --- | --- | --- |
| `sshLite.copyRemoteItem` | Copy | file/folder |
| `sshLite.cutRemoteItem` | Cut | file/folder |
| `sshLite.pasteRemoteItem` | Paste | folder (or connection root) |
| `sshLite.clearRemoteClipboard` | Clear SSH Clipboard | (command palette) |

### package.json — context-menu entries

Added to `view/item/context`, in new group `2_clipboard`:

```jsonc
{ "command": "sshLite.copyRemoteItem",  "when": "view == sshLite.fileExplorer && viewItem =~ /^(file|folder)/", "group": "2_clipboard@1" },
{ "command": "sshLite.cutRemoteItem",   "when": "view == sshLite.fileExplorer && viewItem =~ /^(file|folder)/", "group": "2_clipboard@2" },
{ "command": "sshLite.pasteRemoteItem", "when": "view == sshLite.fileExplorer && viewItem =~ /^(folder|connection)/ && sshLite.hasClipboard", "group": "2_clipboard@3" }
```

### Keybindings

```jsonc
{ "command": "sshLite.copyRemoteItem",  "key": "ctrl+c", "when": "focusedView == sshLite.fileExplorer" }
{ "command": "sshLite.cutRemoteItem",   "key": "ctrl+x", "when": "focusedView == sshLite.fileExplorer" }
{ "command": "sshLite.pasteRemoteItem", "key": "ctrl+v", "when": "focusedView == sshLite.fileExplorer && sshLite.hasClipboard" }
```

### Edge cases

| Case | Behavior |
| --- | --- |
| Paste same-folder | Auto-rename `name (copy).ext`, `name (copy) 2.ext`, … |
| Destination exists | Prompt: Overwrite / Rename / Cancel |
| Cut + paste success | Clear clipboard, refresh both source + dest folder trees |
| Copy + paste success | Keep clipboard (allow repeat paste), refresh dest only |
| Paste to disconnected connection | Error notification, don't clear clipboard |
| Large folder | `withProgress` notification, cancellable |
| Permission denied | Use existing `handlePermissionDenied` sudo fallback |
| Cross-host paste | Identical UX; route to `copyRemoteCrossHost` internally |

### Refresh

After paste:
- Dest folder → `fileTreeProvider.refreshFolder(destConnId, destPath)`
- Source folder (if cut) → `fileTreeProvider.refreshFolder(srcConnId, parentDir(srcPath))`

### Tests

- `RemoteClipboardService`: copy/cut state, context-key side-effect, clear, onDidChange fires
- `FileService.copyRemoteSameHost`: exec called with proper shell-quoted arguments
- `FileService.copyRemoteCrossHost`: mocked SFTP streams for file + folder (recursive)
- Auto-rename helper (`nextCopyName`) covers `.ext`, no-ext, existing `(copy)`, existing `(copy) N`
- Command handlers: clipboard visibility context key toggles, cut clears after paste, copy persists

## Documentation updates (`.adn/`)

- `architecture/overview.md` — mention `RemoteClipboardService` singleton
- `project-structure.md` — add service entry
- `configuration/commands-reference.md` — 4 new commands
- `features/file-operations.md` — copy/cut/paste section
- `testing/testing-strategy.md` — note copy tests
- `CHANGELOG.md` — v0.6.0 entry

## Risk / Rollback

- Clipboard state is in-memory only → no persistence risk
- New commands are additive; no existing command names changed
- Pure-JS implementation uses existing `ssh2` patterns; no new native deps
- Rollback: revert `package.json` + remove new service + handlers; no migration needed
