# File Operations

Covers `FileService` — the largest service (~4097 lines) handling file open/edit/save, upload state machine, auto-refresh, backups, and preloading.

---

## FileService (`src/services/FileService.ts`)

Singleton service managing all file operations between local temp files and remote servers.

### Core Responsibilities

1. **File Mapping**: Track local temp file → remote file associations
2. **Auto-Upload**: Debounced upload on Ctrl+S
3. **Auto-Refresh**: Periodic refresh of open files from server
4. **Smart Refresh**: Tail-based incremental refresh for large/growing files
5. **Backup Management**: Server-side backups for file revert
6. **Preloading**: Background preload of frequently accessed directories/files

---

## File Mapping

Maps local temp file paths to remote file info:

```typescript
private fileMappings: Map<string, FileMapping>;
// Key: normalizeLocalPath(localPath) — lowercase drive letter on Windows
// Value: { remotePath, remoteFile, connection, connectionId }
```

**Path normalization is critical**: Windows drive letters differ between APIs (`C:\` vs `c:\`). ALL Map lookups use `normalizeLocalPath()` from `utils/helpers.ts`.

### Open File Flow

```
1. User clicks file in tree → sshLite.openFile command
2. FileService.openRemoteFile(connection, remoteFile)
3. Create temp dir: os.tmpdir()/ssh-lite/{connectionId}/
4. Download file: CommandGuard.readFile(connection, remotePath)
5. Write to local temp: fs.writeFile(localPath, content)
6. Create file mapping: localPath → { remotePath, connection }
7. Open in editor: vscode.window.showTextDocument(uri)
```

---

## Upload State Machine

Three `Set<string>` track upload state (keyed by normalized local path):

```typescript
uploadingFiles: Set<string>     // Currently uploading
failedUploadFiles: Set<string>  // Last upload failed
skipNextSave: Set<string>       // Skip next save event (programmatic writes)
```

### State Transitions

```
User saves (Ctrl+S)
  │
  ├─ In skipNextSave? → Remove from set, return (don't upload)
  │
  └─ Normal save:
     1. Capture document content
     2. Add to uploadingFiles
     3. Fire _onUploadStateChanged → FileDecorationProvider shows ↑ badge
     4. Start debounced upload (uploadDebounceMs, default 1000ms)
     │
     ├─ More saves arrive? → Reset debounce timer
     │
     └─ Debounce expires (60s timeout):
        5. Upload via CommandGuard.writeFile()
        │
        ├─ Success:
        │   a. Remove from uploadingFiles
        │   b. Fire _onUploadStateChanged → badge clears
        │   c. Log to AuditService
        │
        └─ Failure:
            a. Remove from uploadingFiles
            b. Add to failedUploadFiles
            c. Fire _onUploadStateChanged → ✗ badge
            d. Show error message
```

### Debounce Implementation

```typescript
private uploadTimers: Map<string, NodeJS.Timeout>;
// Key: normalizeLocalPath(localPath)
// Value: setTimeout handle

// Each save resets the timer. Final timer triggers actual upload.
// Timeout: 60 seconds (ensures upload eventually happens)
```

---

## Auto-Refresh

### File Refresh (open files)

Periodically re-downloads open files to detect remote changes:

```
Timer fires (fileRefreshIntervalSeconds, default: 3s)
  │
  ├─ For each open file mapping:
  │   ├─ Skip if dirty (unsaved local changes)
  │   ├─ Skip if uploading (in uploadingFiles set)
  │   ├─ Prioritize focused editor first
  │   ├─ Check remote stat → compare modifiedTime
  │   │
  │   ├─ File unchanged → skip
  │   └─ File changed:
  │       ├─ Small file → full download + replace content
  │       └─ Large file (> smartRefreshThreshold) → tail-based refresh
  │
  └─ LITE: Focused file refreshed first, others batched
```

### Smart Tail Refresh

For files larger than `smartRefreshThreshold` (default 512KB) that are growing:

```
1. stat() → get current size
2. Compare with last known size
3. If file grew: read only new bytes (tail)
4. Append new bytes to local file
5. If file shrank or same: skip (not a growing log)
```

---

## Backup Management

Server-side file backups for revert functionality:

```
Before upload:
  1. Read current remote file content
  2. Store as backup: ~/.ssh-lite-backups/{connectionId}/{remotePath}/{timestamp}
  3. Keep max N backups per file (sshLite.maxBackupsPerFile, default: 10)
  4. Oldest backups auto-deleted when limit exceeded

Revert:
  1. Show backup list (sshLite.showFileBackups)
  2. User selects backup
  3. Upload backup content to remote
  4. Diff view available (sshLite.showChanges)
```

---

## Upload File To Server (`uploadFileTo`)

Upload a local file to a remote directory via the tree context menu.

```
1. Show file picker dialog (defaultUri = last upload folder, remembered in-memory)
2. Upload file via SFTP writeFile
3. Targeted tree refresh: refreshFolder(connectionId, remoteFolderPath) clears cache + refreshes
```

Delete and create-folder commands also use `refreshFolder()` for targeted cache invalidation.

---

## Preloading

Background preloading of directories and files for faster navigation:

```
On connection established:
  1. FolderHistoryService provides frequently accessed paths
  2. PriorityQueueService queues paths by access frequency
  3. FileTreeProvider preloads directory listings (max concurrency: maxPreloadingConcurrency)
  4. FileService preloads frequently opened files

LITE compliance:
  - Default ON but user can disable (sshLite.enablePreloading)
  - Max 5 concurrent operations (configurable)
  - Preload status shown in status bar
  - User can cancel via sshLite.cancelPreloading
```

---

## Events

| Event | Fires When | Used By |
|-------|-----------|---------|
| `onUploadStateChanged` | File starts/finishes uploading | FileDecorationProvider (badges) |
| `onFileContentChanged` | Remote file content changed | FileTreeProvider (refresh) |
| `onWatchedFileChanged` | Watched file detected change | FileTreeProvider (highlight) |
| `onFileMappingChanged` | File mapping added/removed | extension.ts (status bar) |

---

## Change Tracking

Modified file detection with "M" badge and diff icon:

```
1. On file open: store original content hash
2. On upload: compare current content with original
3. If different: mark as modified → "M" badge via FileDecorationProvider
4. Diff icon in tree → sshLite.showChanges command
5. Server backup stores original for comparison
```

Setting: `sshLite.enableChangeTracking` (not in package.json — may be internal)
