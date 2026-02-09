# File Save Flow

Complete flow from user pressing Ctrl+S to remote file update and badge refresh.

---

## Flow Diagram

```
User presses Ctrl+S
    │
    ▼
VS Code fires onDidSaveTextDocument
    │
    ▼
FileService.handleSave(document)
    │
    ├─ Is this an SSH file? (check fileMappings)
    │   └─ NO → return (not our file)
    │
    ├─ In skipNextSave set?
    │   └─ YES → remove from set, return (programmatic write)
    │
    ├─ autoUploadOnSave setting disabled?
    │   └─ YES → return
    │
    ▼
Capture document content (Buffer)
    │
    ▼
Add to uploadingFiles set
Fire _onUploadStateChanged event
    │ → FileDecorationProvider → show ↑ badge (orange)
    │
    ▼
Start/Reset debounce timer (uploadDebounceMs, default 1000ms)
    │
    ├─ More saves arrive? → Reset timer (debounce)
    │
    ▼ (timer expires)
    │
    ├─ confirmUpload setting enabled?
    │   └─ YES → Show confirmation dialog
    │       └─ User cancels → Remove from uploadingFiles, return
    │
    ▼
Create server backup (if change tracking enabled)
    │ → Read current remote content
    │ → Store in backup directory
    │
    ▼
Upload via CommandGuard.writeFile(connection, remotePath, content)
    │ → ActivityService tracks operation
    │ → AuditService logs the upload
    │
    ├─ SUCCESS:
    │   1. Remove from uploadingFiles
    │   2. Fire _onUploadStateChanged → ↑ badge clears
    │   3. Update file stats (size, modifiedTime)
    │   4. Status bar: "$(check) Uploaded filename"
    │
    └─ FAILURE:
        1. Remove from uploadingFiles
        2. Add to failedUploadFiles
        3. Fire _onUploadStateChanged → ✗ badge (red)
        4. Show error: vscode.window.showErrorMessage(...)
```

---

## Key Implementation Details

### Debounce Timer

```typescript
// Map of active debounce timers
private uploadTimers: Map<string, NodeJS.Timeout>;

// On each save:
if (this.uploadTimers.has(localPath)) {
  clearTimeout(this.uploadTimers.get(localPath)!);
}
this.uploadTimers.set(localPath, setTimeout(() => {
  this.performUpload(localPath, content);
}, uploadDebounceMs));  // default 1000ms
```

### Skip Next Save

Used when programmatically writing to local files (e.g., auto-refresh, revert):

```typescript
// Before writing locally:
fileService.skipNextSave.add(normalizeLocalPath(localPath));
fs.writeFileSync(localPath, newContent);
// Next onDidSaveTextDocument for this file is ignored
```

### Upload Timeout

The debounced upload has a 60-second timeout to ensure uploads eventually complete even under continuous rapid saves.

---

## Related Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `autoUploadOnSave` | `true` | Enable/disable auto-upload |
| `uploadDebounceMs` | `1000` | Debounce delay (min: 300ms) |
| `confirmUpload` | `true` | Show confirmation before upload |
| `maxBackupsPerFile` | `10` | Backup history depth |
