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
| `sshLite.googleDrive.fileName` | `string` | `"sshlite-connections.json"` | Name of the file SSH Lite creates in Google Drive when syncing connections (issue #11). Only files created by SSH Lite are accessible (`drive.file` scope). See [connection-portability.md](../features/connection-portability.md) |

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

## Terminal Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshLite.terminal.termType` | `string` | `"xterm-256color"` | `$TERM` advertised to the remote interactive shell. Enables 256-color rendering for TUI apps and shell plugins (fzf-tab, vim, tmux, htop, powerlevel10k). Use `vt100` only for very old servers lacking the `xterm-256color` terminfo entry. |
| `sshLite.terminal.forwardEnv` | `boolean` | `true` | Forward the client's locale (`LANG`, `LC_*`) and `COLORTERM` to new terminals, mirroring a native `ssh` session (`SendEnv`). Improves UTF-8 glyph and color rendering. **Server-gated**: the remote `sshd` must allow them via `AcceptEnv` (most distributions allow `LANG LC_*` by default). |
| `sshLite.terminal.env` | `object` | `{}` | Extra environment variables for new terminals, e.g. `{ "COLORTERM": "truecolor" }`. Merged over the forwarded locale variables (these win on conflict). Also subject to the server's `AcceptEnv`. |

**LITE note**: these are applied once when the shell channel opens (no polling, no extra server commands). A bare interactive shell keeps the previous behaviour, so the change is backward-compatible. See `.adn/features/terminal-port-forwarding.md` → *Native-parity PTY*.

---

## File Operations

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.autoUploadOnSave` | `boolean` | `true` | — | Auto-upload files when saved |
| `sshLite.uploadDebounceMs` | `number` | `1000` | `300` | Debounce delay before upload (ms). LITE: min 300ms prevents server spam |
| `sshLite.confirmUpload` | `boolean` | `true` | — | Show confirmation before uploading |
| `sshLite.maxBackupsPerFile` | `number` | `10` | `1` (max: `50`) | Backup history per file for revert |
| `sshLite.editorTabPrefix` | `enum` | `"userAndHost"` | — | Tab title prefix for remote files (issue #8). `userAndHost` = `[user@host] file` (or `[tabLabel]` if set); `label` = `[tabLabel]` only when set, else just `file`; `none` = filename only (compact tabs). Applied by `buildTabPrefix()` in `connectionPrefix.ts`; affects files opened after the change. |

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
| `sshLite.maxPreloadingConcurrency` | `number` | `5` | `1`/`10` | Max parallel preload operations per server. Each server gets its own independent queue. Lower = less server load |

**LITE note**: Preloading is opt-in by default (enabled but controlled). Lower concurrency for shared/busy servers.

---

## Search & Filter

| Setting | Type | Default | Min/Max | Description |
|---------|------|---------|---------|-------------|
| `sshLite.searchMaxResults` | `number` | `2000` | `1` | Max search results. Higher = slower on large dirs |
| `sshLite.filterMaxResults` | `number` | `1000` | `1` | Max file filter results |
| `sshLite.searchParallelProcesses` | `number` | `5` | `1`/`50` | Default parallel search workers per folder. Each server can override this inline in the search panel. Workers process file batches concurrently for faster results. Auto-throttled when user has active non-search operations, and divided equally among concurrent searches |
| `sshLite.searchUseDefaultExcludes` | `boolean` | `true` | — | Auto-exclude common directories from search (`.git`, `node_modules`, `.svn`, `.hg`, `CVS`, `.DS_Store`, `bower_components`, `*.code-search`). Matches VS Code's default search behavior |
| `sshLite.maxChannelsPerServer` | `number` | `8` | — | Max concurrent SSH channels per server. Adapts downward on channel limit errors. Increase if your server has MaxSessions > 10. |
| `sshLite.diagnosticLogging` | `boolean` | `false` | — | Verbose diagnostic logs in the **SSH Lite** Output channel. Off by default (LITE: zero overhead unless opted in). Enable when filing a bug report — captures connect lifecycle (handshake, auth methods, server banner, ssh2 error level/code), channel semaphore acquire/release/timeout, exec retries, and connection-manager state changes. The cached flag is refreshed on `onDidChangeConfiguration` so toggling takes effect immediately. |

**Parallel search (file-level worker pool)**: When `searchParallelProcesses > 1`, the search panel uses a file-level worker pool. Workers share a mixed queue of `dir` and `files` items. A `dir` item calls `listEntries()` to discover files + subdirs at one level, batches files by byte size (32KB limit for cross-OS safety), and adds file batches + subdirs back to the queue. A `files` item calls `searchFiles()` with an explicit file path array. Workers pick items from the queue until exhausted. This gives perfect load balancing — workers never idle, no duplication, no missed files.

**Priority throttling**: Workers are auto-throttled to 1 when the user has active non-search operations (file browsing, uploads, downloads, terminals) on the same connection, then restored when those operations complete. Multiple concurrent searches on the same connection divide workers equally (`ceil(fullWorkerCount / searchCount)`).

---

## File Tooltips

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshLite.localFileTooltips` | `boolean` | `true` | Show file info tooltip (size, created, modified, accessed, permissions) when hovering files in VS Code explorer. Also controls SSH remote file tooltips on editor tabs |

**Local files**: Uses `fs.statSync()` to read metadata. Shows size (or "Directory"), created time (`birthtimeMs`), modified time, accessed time, and permissions (`rwxr-xr-x` from `stat.mode` bitmask). Path is omitted — VS Code already shows it natively.

**SSH temp files**: Shows remote path, server (host:port:user), size, modified, accessed, owner:group, and permissions from `IRemoteFile`. Falls back to `lastRemoteSize`/`lastRemoteModTime` for preloaded files.

---

## Temp Files & Audit

| Setting | Type | Default | Min | Description |
|---------|------|---------|-----|-------------|
| `sshLite.tempFileRetentionHours` | `number` | `504` | `0` | Auto-delete temp files older than N hours. Default: 504 = 21 days. **0 = disabled** |
| `sshLite.diffTempRetentionHours` | `number` | `24` | -- | Auto-delete orphaned `sshlite-diff-*` temp directories (from "Diff with Local") older than N hours. Swept by `HousekeepingService` at activation and on FileService's hourly cleanup timer. The "Diff with Local" feature already removes its own temp dir when the diff tab closes; this is the safety net for any left behind |
| `sshLite.auditLogPath` | `string` | `""` | — | Custom audit log path. Empty = default location |

---

## Support View NPC (animated coder)

The "Support SSH Lite" panel's pixel-art coder reacts to activity. These settings control the two reaction sources that look outside the current VS Code window. Both default **ON** and both are cosmetic: turning either off removes only the coder's reactions, nothing functional.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshLite.npcAiActivity` | `boolean` | `true` | React (and float a name label) when a known AI coding assistant is working. Watches the transcript / history files those tools write on disk via `vscode.createFileSystemWatcher`: file-change events only, never the file contents. Watchers attach only while the Support view is visible and are disposed on hide / disable / deactivate |
| `sshLite.npcAiActivityTools` | `string[]` | `[]` | Which AI tools to watch. **Empty = all known tools** (`claude-code`, `codex`, `gemini`, `cursor`, `aider`, `cline`, `roo`, `kilo`, `continue`, `github-copilot`). List specific ids to limit the set |
| `sshLite.npcAutoSetupHooks` | `boolean` | `true` | Auto-install AI input hooks the first time the Support view is opened, for the hook-capable tools detected on this machine (Claude Code, Codex, Gemini, Cursor, Copilot). Lazy (only on first panel-open, never at activation/tests), once-only (a globalState flag, so a later manual "Remove" is respected), append-only + backed up. Off → require the manual "Set up AI hooks" button. **Caveat:** the Claude Code VS Code extension doesn't execute hooks (Anthropic limitation) — hooks fire for Claude in a terminal, Codex/Gemini CLIs, Cursor, Copilot |
| `sshLite.npcCrossWindowBeacon` | `boolean` | `true` | React when another VS Code window of the same install is active. Uses a tiny shared beacon file in `globalStorageUri` carrying only a timestamp, a coarse `editor`/`terminal` category, and the window's instance id; no keystrokes, paths, or host names. Event-driven (no polling); the reader runs only while the Support view is visible; the file is deleted on deactivate |
| `sshLite.npcBannerText` | `string` | `"VN"` | Text on the occasional cheering banner above the coder's head (next to a small Vietnam flag). At most 5 characters (trimmed; longer values are clamped). Empty shows the flag only. Editable from the gear → NPC settings panel or here. See `.adn/features/support-view.md` "Cheering banner" |
| `sshLite.npcBannerMode` | `enum` | `"never"` | When the cheering headband appears: `occasional` (once in a while), `always` (kept shown), or `never` (default — off). One mutually-exclusive control (a dropdown in the gear → NPC settings panel, or here) |

**Privacy posture (LITE)**: a sandboxed extension cannot observe keystrokes in other VS Code windows, in terminals it did not create, or anywhere in the operating system, without a native global keyboard hook (a keylogger), which SSH Lite will not ship. So these signals are coarse, **content-free**, event-driven file watches, gated to when the Support view is visible. For a richer reaction that flies the words you actually type into an AI tool, the user can opt in to **AI input hooks** (Support view → gear → "Set up AI hooks"): each AI tool runs a tiny prompt-submit hook that pushes the prompt to a beacon SSH Lite watches — SSH Lite still never reads the tools' transcripts. See `.adn/features/support-view.md` and `.adn/features/ai-hooks.md`.

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
| Saved port forward rules | Auto-restore port forwards on connect |
| Per-server search settings | Server-specific `maxSearchProcesses` overrides |
| Last connection attempts | Per-host success/failure with timestamps and errors |
