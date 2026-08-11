# Activity & Audit

Covers `CommandGuard` (activity tracking middleware), `ActivityService` (operation tracking), and `AuditService` (JavaScript Object Notation array logging).

---

## CommandGuard (`src/services/CommandGuard.ts`)

Man-in-the-middle for all SSH operations. Provides unified activity tracking, monitoring, and cancellation.

### Why CommandGuard Exists

Without CommandGuard, each service would need its own activity tracking logic. CommandGuard centralizes this:

```typescript
// WRONG - bypasses tracking, Activity panel doesn't show it
const data = await connection.readFile('/etc/hosts');

// CORRECT - tracked, cancellable, shown in Activity panel
const data = await commandGuard.readFile(connection, '/etc/hosts', {
  description: 'Download hosts file',
  cancellable: true,
  onCancel: () => { /* cleanup */ }
});
```

### Tracked Methods

```typescript
exec(connection, command, options?)     → Promise<string>    // Shell commands
readFile(connection, remotePath, options?)  → Promise<Buffer>    // File download
writeFile(connection, remotePath, content, options?) → Promise<void> // File upload
listFiles(connection, remotePath, options?)  → Promise<IRemoteFile[]> // Directory listing
deleteFile(connection, remotePath, options?) → Promise<void>    // File/folder delete
```

### Tracking Options

```typescript
interface TrackingOptions {
  description?: string;     // Activity panel text
  detail?: string;          // Additional detail
  type?: ActivityType;      // Override activity type
  cancellable?: boolean;    // Show cancel button
  onCancel?: () => void;    // Cancel callback
}
```

### LITE Principle

Only **significant user-initiated operations** are tracked. Quick metadata lookups bypass CommandGuard:

```typescript
// Tracked (shown in Activity panel):
commandGuard.readFile(conn, path)     // User opens file
commandGuard.exec(conn, grepCommand)  // User searches
commandGuard.writeFile(conn, path, content)  // User saves

// NOT tracked (too noisy):
connection.stat(path)                  // Internal metadata check
connection.exec('realpath ~')          // Path expansion
connection.exec('which inotifywait')   // Capability detection
```

---

## ActivityService (`src/services/ActivityService.ts`)

Tracks in-progress and completed operations for the Activity panel.

### Activity Types

```typescript
type ActivityType = 'search' | 'download' | 'upload' | 'directory-load' |
  'file-refresh' | 'preload' | 'monitor' | 'terminal' | 'connect' |
  'disconnect' | 'reveal';
```

### Activity Lifecycle

`ActivityService` tracks Secure Shell (SSH) operations. It keeps cancellation and
list clearing as separate user actions:

```
startActivity(type, connectionId, serverName, description, options?)
  → returns activityId (string)
  → Activity shows as "running" with spinner

completeActivity(activityId, resultDetail?)
  → Activity shows as "completed" with checkmark
  → Duration calculated

failActivity(activityId, errorMessage)
  → Activity shows as "failed" with error icon
  → Error message displayed

cancelActivity(activityId)
  → Calls onCancel callback (if provided)
  → Activity shows as "cancelled"

cancelAll()
  → Calls each running activity's cancellation callback
  → Marks those activities as cancelled

clearAll()
  → Removes activities from the Activity panel only
  → Does not call cancellation callbacks; running SSH operations continue
```

### Activity Panel Grouping

Two grouping modes (toggle via `sshLite.toggleActivityGrouping`): server (the
default) and activity type. Group descriptions always state both running and
total counts, for example `1 running · 3 activities`.

```
Grouped by server:
  └─ server1 — 1 running · 2 activities
       ├─ Download: config.json ✓ 2.1 KB
       └─ Upload: app.ts ✓ 1.5 KB
  └─ server2 — 0 running · 1 activity
       └─ Search: "TODO" ✓ 15 results
```

### ActivityTreeProvider (`src/providers/ActivityTreeProvider.ts`)

Displays activities in the Activity panel tree view:

```
sshLite.activity
  ├─ ServerGroupTreeItem or TypeGroupTreeItem
  └─ ActivityTreeItem
```

- A running activity uses `sync~spin`; when progress exists its description is
  `progress percentage · detail`, or only the progress percentage when no detail exists.
- Completed, failed, and cancelled activities use `check`, `error`, and
  `circle-slash`. Tooltips name status, server, duration, and detail so status
  does not depend on color alone.
- An empty panel says `No activities` and `Running SSH operations will appear here`.

---

## AuditService (`src/services/AuditService.ts`)

Logs all file operations to a local JavaScript Object Notation (JSON) array file for an audit trail.

### Audit Entry Format

```typescript
interface AuditEntry {
  timestamp: string;        // ISO 8601
  operation: string;        // 'download' | 'upload' | 'delete' | 'create'
  connectionId: string;
  hostName: string;
  remotePath?: string;
  localPath?: string;
  success: boolean;
  error?: string;
  diff?: {                  // For uploads with change tracking
    before: string;
    after: string;
  };
}
```

### Audit Log Location

- Local `file:` workspace: `<workspace>/.vscode/ssh-lite-audit.json`
- Remote-SSH, virtual, or no workspace: `~/.ssh-lite/audit.json` on the extension host
- Custom: `sshLite.auditLogPath` setting; overrides both defaults

`AuditService` never passes a non-`file:` workspace URI's `fsPath` to the raw Node.js filesystem. In a Remote-SSH window that path belongs to the server, while this user interface extension runs locally; using it as a local path can abort activation before the tree providers register.

### Commands

| Command | Description |
|---------|-------------|
| `sshLite.showAuditLog` | Open audit log in editor |
| `sshLite.exportAuditLog` | Export audit log to file |
| `sshLite.clearAuditLog` | Clear all audit entries |

## User Actions

| Action | Primitives | Notes |
|---|---|---|
| Tail logs | readFile, runLong | |
| Watch file | readFile, readFile, readFile | Poll pattern; native watcher primitives in v0.8.1 |
