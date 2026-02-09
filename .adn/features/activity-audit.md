# Activity & Audit

Covers `CommandGuard` (activity tracking middleware), `ActivityService` (operation tracking), and `AuditService` (JSON line logging).

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
type ActivityType = 'connect' | 'download' | 'upload' | 'terminal' | 'search' | 'delete' | 'other';
```

### Activity Lifecycle

```
startActivity(type, connectionId, hostName, description, options?)
  → returns activityId (string)
  → Activity shows as "in progress" with spinner

completeActivity(activityId, resultDetail?)
  → Activity shows as "completed" with checkmark
  → Duration calculated

failActivity(activityId, errorMessage)
  → Activity shows as "failed" with X icon
  → Error message displayed

cancelActivity(activityId)
  → Calls onCancel callback (if provided)
  → Activity shows as "cancelled"
```

### Activity Panel Grouping

Two grouping modes (toggle via `sshLite.toggleActivityGrouping`):

```
Flat (default):
  ├─ Download: config.json (server1) ✓ 2.1 KB
  ├─ Upload: app.ts (server1) ✓ 1.5 KB
  └─ Search: "TODO" (server2) ✓ 15 results

Grouped by server:
  └─ server1 (2 activities)
       ├─ Download: config.json ✓ 2.1 KB
       └─ Upload: app.ts ✓ 1.5 KB
  └─ server2 (1 activity)
       └─ Search: "TODO" ✓ 15 results
```

### ActivityTreeProvider (`src/providers/ActivityTreeProvider.ts`)

Displays activities in the Activity panel tree view:

```
sshLite.activity
  ├─ ActivityTreeItem (in-progress: spinner icon)
  ├─ ServerGroupTreeItem (when grouped)
  └─ ActivityTreeItem (completed: checkmark)
```

---

## AuditService (`src/services/AuditService.ts`)

Logs all file operations to a local JSON Lines file for audit trail.

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

Default: `~/.ssh-lite/audit.jsonl`
Custom: `sshLite.auditLogPath` setting

### Commands

| Command | Description |
|---------|-------------|
| `sshLite.showAuditLog` | Open audit log in editor |
| `sshLite.exportAuditLog` | Export audit log to file |
| `sshLite.clearAuditLog` | Clear all audit entries |
