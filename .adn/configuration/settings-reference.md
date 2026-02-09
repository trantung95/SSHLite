# Settings Reference

All `sshLite.*` configuration settings with types, defaults, and LITE compliance notes.

---

## Access Pattern

```typescript
const config = vscode.workspace.getConfiguration('sshLite');
const value = config.get<number>('connectionTimeout', 30000);
await config.update('hosts', updatedHosts, vscode.ConfigurationTarget.Global);
```

---

## Host Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshLite.hosts` | `array` | `[]` | Saved SSH hosts. Each entry: `{ name, host, port?, username, privateKeyPath? }` |
| `sshLite.sshConfigPath` | `string` | `""` | Custom path to SSH config file. Empty = `~/.ssh/config` |
| `sshLite.defaultRemotePath` | `string` | `"~"` | Default remote path when connecting |

### Host Object Schema

```json
{
  "name": "string (required)",
  "host": "string (required)",
  "port": "number (default: 22)",
  "username": "string (required)",
  "privateKeyPath": "string (optional)"
}
```

---

## Connection Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshLite.connectionTimeout` | `number` | `30000` | Connection timeout in milliseconds |
| `sshLite.keepaliveInterval` | `number` | `30000` | Keepalive ping interval in milliseconds |

---

## File Operations

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.autoUploadOnSave` | `boolean` | `true` | — | Auto-upload files when saved |
| `sshLite.uploadDebounceMs` | `number` | `1000` | `300` | Debounce delay before upload (ms). LITE: min 300ms prevents server spam |
| `sshLite.confirmUpload` | `boolean` | `true` | — | Show confirmation before uploading |
| `sshLite.maxBackupsPerFile` | `number` | `10` | `1` (max: `50`) | Backup history per file for revert |

---

## Auto-Refresh

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.treeRefreshIntervalSeconds` | `number` | `10` | `0` | File tree auto-refresh interval. **0 = disabled** (LITE: off by default) |
| `sshLite.fileRefreshIntervalSeconds` | `number` | `3` | `0` | Open file auto-refresh interval. **0 = disabled** |
| `sshLite.smartRefreshThreshold` | `number` | `512000` | `0` | File size (bytes) for smart tail-based refresh. Files larger than this use incremental refresh. **0 = always full download** |

**LITE compliance**: `treeRefreshIntervalSeconds` defaults to 10 (not aggressive). Set to 0 to fully disable polling.

---

## Large File Handling

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.largeFileSizeThreshold` | `number` | `104857600` | — | Large file threshold (default: 100MB). Files above this show a warning |
| `sshLite.progressiveDownloadThreshold` | `number` | `1048576` | `0` | Progressive download threshold (default: 1MB). Files above this show tail preview first. **0 = disabled** |
| `sshLite.progressivePreviewLines` | `number` | `1000` | `100` (max: `10000`) | Lines shown in tail preview for large files |
| `sshLite.progressiveTailFollow` | `boolean` | `true` | — | Enable live tail-f during preview (new lines auto-appear) |
| `sshLite.progressiveTailPollInterval` | `number` | `3000` | `1000` (max: `10000`) | Tail-f polling interval in ms |
| `sshLite.progressiveChunkSize` | `number` | `65536` | `8192` (max: `1048576`) | SFTP chunk size for progress reporting during large downloads (default: 64KB) |

### Progressive Download Interaction

```
File opened → size > progressiveDownloadThreshold (1MB)?
  YES → Show last progressivePreviewLines (1000) lines immediately
      → Download full file in background (progressiveChunkSize chunks)
      → If progressiveTailFollow enabled: poll for new lines every progressiveTailPollInterval
      → Replace preview with full content when download completes
  NO  → Download full file directly
```

---

## Preloading

| Setting | Type | Default | Min/Max | Description |
|---------|------|---------|---------|-------------|
| `sshLite.enablePreloading` | `boolean` | `true` | — | Enable background preloading of directories |
| `sshLite.maxPreloadingConcurrency` | `number` | `5` | `1`/`10` | Max parallel preload operations. Lower = less server load |

**LITE note**: Preloading is opt-in by default (enabled but controlled). Lower concurrency for shared/busy servers.

---

## Search & Filter

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.searchMaxResults` | `number` | `2000` | `1` | Max search results. Higher = slower on large dirs |
| `sshLite.filterMaxResults` | `number` | `1000` | `1` | Max file filter results |

---

## Temp Files & Audit

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.tempFileRetentionHours` | `number` | `504` | `0` | Auto-delete temp files older than N hours. Default: 504 = 21 days. **0 = disabled** |
| `sshLite.auditLogPath` | `string` | `""` | — | Custom audit log path. Empty = default location |

---

## Internal Settings (do not edit manually)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshLite.credentialIndex` | `object` | `{}` | Credential metadata index. Secrets stored in OS keychain |

---

## Context Keys (set via setContext)

These are NOT user settings — they're set programmatically and used in `when` clauses:

| Key | Type | Set When |
|-----|------|----------|
| `sshLite.hasConnections` | `boolean` | Any connection active |
| `sshLite.hasHostFilter` | `boolean` | Host name filter active |
| `sshLite.hasFilenameFilter` | `boolean` | Filename filter active |
| `sshLite.hasOrphanedFiles` | `boolean` | Orphaned SSH files detected |
| `sshLite.isConnectedFile` | `boolean` | Active editor is connected SSH file |
| `sshLite.hasActiveRemoteFile` | `boolean` | Active editor is any remote file |
| `sshLite.hosts.expandState` | `number` | Host tree expand state (0/1/2) |
| `sshLite.fileExplorer.expandState` | `number` | File tree expand state (0/1/2) |
| `sshLite.activity.expandState` | `number` | Activity tree expand state (0/1/2) |
| `sshLite.portForwards.expandState` | `number` | Port forward expand state (0/1/2) |

---

## Persisted in GlobalState (not settings)

| Key | Purpose |
|-----|---------|
| Host key fingerprints | SSH host verification |
| Search sort order | Checked-first vs alphabetical |
| Folder access history | Preloading priorities |
