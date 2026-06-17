# Connection Protocols: SSH/SFTP and FTP/FTPS (issue #9)

SSH Lite supports two transport protocols, both **server-lite** (nothing is installed on the remote):

- **SSH / SFTP** — the full feature set (browse, edit, terminal, search, monitor, system tools, port forwarding, sudo, server-side backups).
- **FTP / FTPS** — **file operations only** (browse, edit, transfer). Added in issue #9.

Both implement a protocol-agnostic `IConnection` interface, so the file tree, editor, and transfer code do not care which protocol is in use. Shell-dependent features are hidden for FTP connections rather than emulated.

## Architecture

| Piece | Role |
|-------|------|
| `IConnection` (`src/types.ts`) | Shared contract: lifecycle, file operations, `resolveHomePath()`, `capabilities`, events |
| `ISSHConnection extends IConnection` | Adds the ssh2-only surface: `client`, `exec`, `shell`, `forwardPort`, `stopForward` |
| `SSHConnection` | Implements `ISSHConnection` (ssh2 + SFTP) |
| `FTPConnection` (`src/connection/FTPConnection.ts`) | Implements `IConnection` over the pure-JS `basic-ftp` library |
| `ConnectionFactory.createConnection(host, cred)` | Returns `FTPConnection` when `getConnectionType(host) === 'ftp'`, else `SSHConnection` |
| `IConnectionCapabilities` | Per-connection feature flags used to gate shell-only behavior |

`ConnectionManager` stores `Map<string, IConnection>` and creates connections via the factory. Its public accessors are typed `SSHConnection` through a documented downcast bridge for backward compatibility; this is safe because FTP connections only ever flow through the protocol-agnostic file-ops / tree paths, and the UI hides SSH-only commands from FTP rows.

## Capability matrix

| Capability | SSH/SFTP | FTP/FTPS |
|------------|:--------:|:--------:|
| Browse, open/edit/save, upload/download | yes | yes |
| Rename, delete (recursive), mkdir, new file/folder | yes | yes |
| Properties, copy path, filename filter | yes | yes |
| Interactive terminal | yes | no |
| Cross-server search | yes | no |
| Server monitor, system tools (processes/services/env/cron) | yes | no |
| Server-side backups | yes | no (local `.bak` history still kept) |
| Sudo | yes | no |
| Port forwarding | yes | no |
| Snippets, run-script, push public key, remote diff | yes | no |
| Copy / cut / paste (same-host and cross-host) | yes | yes (issue #14) |
| Index folder for filename search | yes | no |
| Native (inotify/fswatch) file watch | yes | no (falls back to polling) |

Recursive directory delete works over FTP because it walks the tree with `listFiles` + `deleteFile` (no shell `rm -rf`).

Copy/cut/paste over FTP (issue #14): cut/move uses FTP `rename`; copy is client-mediated — the file is downloaded then re-uploaded under the new name on the same connection (folders recurse via `listFiles` + `mkdir`). There is no FTP server-side copy command, so this is the only correct approach. A copy of a folder into its own subtree is refused (it would recurse forever, unlike SSH `cp -r` which the shell blocks).

## FTP options

- **Plain FTP vs FTPS**: the `secure` host field selects explicit FTPS (TLS) via basic-ftp. Certificate validation is controlled by `sshLite.ftpRejectUnauthorized` (default `true`; disable only for trusted self-signed servers).
- **Anonymous login**: the `anonymous` host field forces the username to `anonymous` and skips the credential prompt.
- The add-host flow (`HostService.promptAddHost` / `promptEditHost`) asks SSH vs FTP first, then for FTP asks plain vs FTPS and username/password vs anonymous; the private-key prompt is skipped for FTP. Default port is 21 for FTP, 22 for SSH.

## Transport model (basic-ftp)

`basic-ftp` is pure JavaScript with no native dependencies (keeps the LITE footprint; ssh2 stays the only crypto-native dependency). It uses a **single control socket and runs one command at a time**, but the file tree preloads directories in parallel. `FTPConnection` therefore funnels every public method through an internal **serialization queue** so concurrent calls run sequentially without corrupting the control socket.

| `IConnection` method | basic-ftp call |
|----------------------|----------------|
| `listFiles` | `client.list(path)` (mapped to `IRemoteFile`, directories first). When the listing is empty, existence is confirmed before returning (see note below). |
| `readFile` | `client.downloadTo(buffer-sink, path)` |
| `writeFile` | `client.uploadFrom(Readable.from(buf), path)` |
| `deleteFile` | `client.remove` (file) / `client.removeDir` (directory), after a stat |
| `mkdir` | `client.ensureDir(path)` then restore the working directory |
| `rename` | `client.rename(from, to)` |
| `stat` / `fileExists` | list the parent directory and match the basename |
| `resolveHomePath` | cached `client.pwd()` |

### Modification times (issue #15)

basic-ftp only fills `FileInfo.modifiedAt` (a real `Date`) when the server answers the machine-readable **MLSD** command. Most FTP/FTPS servers answer the older **LIST** command, where basic-ftp leaves `modifiedAt` undefined and exposes only `rawModifiedAt` (a human string like `"Jun 11 14:35"`, `"Mar 3 2021"`, or the DOS `"06-16-24 10:30AM"`). The old mapping fell back to `0` = 1 Jan 1970, so every LIST-mode file rendered as "56 years ago". `src/connection/ftpDate.ts` → `parseFtpModifiedTime` now parses `rawModifiedAt` (Unix recent/old, DOS) into Unix ms, returning `undefined` (rendered blank) only when nothing is parseable. LIST dates carry no timezone, so they are interpreted in the client's local time — the same limitation every FTP client has. As defense-in-depth, `formatRelativeTime`/`formatDateTime` render `0`/`NaN` as blank/`Unknown` rather than 1970.

## listFiles on a missing directory (SSH parity)

basic-ftp (and both vsftpd and pure-ftpd) answer `LIST` of a **missing** directory with an empty success rather than an error, unlike SFTP `readdir`, which throws "No such file". Left unguarded, a deleted/renamed folder would render as a misleading empty folder over FTP while erroring over SSH. `FTPConnection.listFiles` therefore confirms existence only when the listing is empty: it calls `statRaw` (which lists the parent and matches the basename, short-circuiting home/root with no network call) and throws `FTPError('No such directory')` only when it can **prove** the directory is absent (parent listed fine, basename missing). A real empty directory returns `[]`, and if the existence probe itself fails (for example an unreadable parent on a non-chrooted server) the successful empty listing is trusted and `[]` is returned rather than surfacing a misleading error. The extra round-trip is paid solely for empty/missing directories; populated directories and home/root cost nothing.

## 550 errors are server refusals, not a path bug (issue #17)

FTP reply code **550** ("Requested action not taken; file unavailable") is the access / permission / not-found class. On shared hosting the FTP account can `LIST` a directory but cannot modify its contents because the files are owned by another account (the web server) or the parent folder is not writable, so the server refuses every mutation with a 550 while browsing keeps working. The raw replies are server-specific and opaque, e.g. vsftpd answers `DELE` with "550 Delete operation failed.", `RETR` with "550 Failed to open file.", and `RMD` with "550 Remove directory operation failed.".

Our code passes correct paths in this case (the matching `LIST` succeeds and a file the account owns deletes fine), and unlike SSH there is no `sudo` to elevate over FTP, so a retry keeps failing. `describeFtpFailure(label, error)` in `FTPConnection` therefore wraps any 550 (detected via `error.code`, the numeric reply code basic-ftp sets) with an actionable explanation while preserving the server's own message (true data). Non-550 errors keep the plain `FTP <label> failed: <message>` wrapper. `FileService.deleteRemote` already skips the sudo-retry branch for FTP because `capabilities.supportsSudo` is false. Covered by `FTPConnection.test.ts` ("describeFtpFailure", plus the deleteFile 550 case) and `src/integration/docker-ftp-permission.test.ts` (real vsftpd, root-owned fixtures planted via `docker exec`).

## Home and path semantics

FTP has no `~`. The login directory (often the chroot root `/`) is the home, returned by `resolveHomePath()` (a cached `pwd`). Paths are always POSIX and absolute. The protocol-agnostic browse/reveal/default-folder code calls `resolveHomePath()` instead of `exec('echo ~')`, so it never assumes a shell.

## UI gating mechanism

FTP tree rows carry a `.ftp` marker right after their base `contextValue`: `connection.ftp`, `file.ftp`, `folder.ftp`, `folder.ftp.filtered`, `connection.ftp.filtered`, `connectedServer.ftp`. In `package.json`:

- Shell-only command `when` clauses use a `(?!\.ftp)` negative lookahead (for example `viewItem =~ /^connection(?!\.ftp)/`) so they no longer match FTP rows.
- Shared commands use `viewItem =~ /^connection|file|folder/`, which still matches the `.ftp` variants automatically.
- The filename-filter commands use `viewItem =~ /^...(\.ftp)?...$/` so they stay available on FTP rows.

`FileService` gates the remaining shell-only paths in code via `connection.capabilities`: server-side backup (`createServerBackup` / `createDirectoryBackup`) early-returns for FTP, and the file-open watcher skips native `watchFile` and falls back to polling (`stat`-based change detection).

## Settings

- `sshLite.ftpRejectUnauthorized` (boolean, default `true`) — reject FTPS servers whose TLS certificate cannot be verified.
- The `sshLite.hosts` item schema gained `connectionType` (enum ssh/ftp), `secure`, and `anonymous`.

## Capability guards (no crash on FTP)

Menu `when` clauses only HIDE shell-only rows for FTP. Keybindings, the Command Palette, connection pickers, the active-connection path, and auto-restore all bypass menu gating, and `ConnectionManager` hands out connections typed as `SSHConnection` (a downcast), so the compiler cannot catch an SSH-only call landing on FTP - it would throw a runtime TypeError. SSH-only features are therefore guarded in code via `src/utils/capabilityGuard.ts`:

- `ensureCapability(conn, cap, action?)` at command-handler entry: shows a friendly warning and returns false (early-return). Pickers also filter: `selectConnection(cm, requireCapability?)` (now also passed `'supportsServerBackup'` by the `showAllBackups` / `openServerBackupFolder` handlers), the SSH Tools `getConnectedConnections` (requires `supportsExec`), `PortForwardService.promptForwardPort`, and `buildServerSearchEntries` (FTP hosts excluded from cross-server search).
- `assertCapability(conn, cap, action?)` at the service sink (throws a clear Error) as a backstop, so the SSH-only method is never reached: `CommandGuard.openShell/exec/searchFiles`, `TerminalService.createTerminal`, `PortForwardService.forwardPort`, `SystemToolsService.*`, `SshKeyService.pushPublicKey`, `FilenameIndexService.buildIndex`, `FileService` server-backup / large-file / properties methods, the progressive download/preview path, and every `ServerMonitorService` entry method (`quickStatus`, `diagnoseSlowness`, `watchStatus`, `checkService`, `listServices`, `recentLogs`, `networkDiagnostics`, `fetchServerStatus` use `supportsExec`; `watchLiveTerminal` uses `supportsShell`).
- `hasCapability` is LENIENT: a capability counts as unsupported only when explicitly `false` (what FTP reports). A connection with no `capabilities` object is treated as capable (legacy/SSH default), so test stubs and any unknown-kind connection behave as SSH.

Search and exec calls that run DIRECTLY on the connection (FileTreeProvider deep/filename filter, SearchPanel, FilenameIndexService, ServerMonitorService, FileService) bypass `CommandGuard`, so each has its own guard - guarding `CommandGuard` alone is not enough. `SearchPanel`'s LEGACY (default-scope) search path has its own `hasCapability(conn, 'supportsSearch')` skip too, mirroring the server-list branch - the `showSearch` entry also FTP-filters the default scopes it adds (`extension.ts`), so an FTP connection can never reach the SSH-only `searchFiles`.

## Tests

- `src/connection/FTPConnection.test.ts` — method-to-basic-ftp mapping, serialization queue, anonymous login, 530 to `AuthenticationError`, capabilities (mocked `basic-ftp`).
- `src/connection/ConnectionFactory.test.ts` — branch by `connectionType`.
- `src/services/HostService.test.ts` — FTP field round-trip through save/load and export/import (backward compat: missing `connectionType` loads as SSH).
- `src/__tests__/ftp-menu-gating.test.ts` — audits that every shell-only menu entry excludes `.ftp` and that no inline icon slot collides.
- `src/integration/docker-ftp-fileops.test.ts` — quick smoke against the vsftpd container (port 2207): full file round-trip including rename and concurrent serialization.
- `src/integration/docker-ftp-servers.test.ts` — FTPConnection MATRIX across multiple real server implementations: vsftpd (delfer, port 2207, not chrooted, rename allowed), pure-ftpd (stilliard, port 2208, chrooted home `/`, rename denied so the graceful FTPError path is covered), and pure-ftpd over explicit FTPS/TLS (self-signed cert + `ftpRejectUnauthorized=false`). Catches LIST/MLSD parsing, path, and rename differences mocks cannot.
- `src/integration/docker-ftp-fileservice.test.ts` — the REAL `FileService` driven against live FTP: a >1MB `openRemoteFile` (proves it routes to `readFile`, not the SFTP-only chunked path that crashed), `downloadFileTo`, `deleteRemote` (file + non-empty directory), `createFolder`/`createFile`, `deleteRemotePath` (recursive), `copyRemoteCrossHost` between two FTP hosts, `copyRemoteSameHost` on one FTP host (file + recursive folder, issue #14), and `listFiles` returning a real recent `modifiedTime` (not 1970, issue #15).
- `src/utils/capabilityGuard.test.ts` — the guard helpers (`hasCapability` lenient rule, `ensureCapability` warn+false, `assertCapability` throw).
- `src/__tests__/ftp-capability-guards.test.ts` — feeds each guarded service sink an FTP-capability connection and asserts it throws `/not available over FTP/i` (proving the SSH-only method is never reached, i.e. no TypeError).
- `src/integration/docker-ftp-stress.test.ts` — edge-case matrix over vsftpd + pure-ftpd: 0-byte / 8 MB binary / full-0..255-byte / UTF-8 payloads, filenames with spaces+unicode, deep nested mkdir, 25 concurrent write+read pairs verified byte-for-byte (LITE no-data-loss), overwrite-in-place, the missing-dir-vs-empty-dir contract, every error branch (read/stat/list/delete of a missing path), reconnect, operate-after-disconnect, and connection-level failures (wrong password to `AuthenticationError`, dead port, empty hostname).
- `src/integration/ftpTestHelpers.ts` — shared `connectWithRetry` used by all FTP suites' `beforeAll`. pure-ftpd (2208) blocks connections (plain AND FTPS) for ~30-90s on first boot while generating its self-signed cert + 2048-bit DH params, so a cold container answers connect with "Server sent FIN packet" / a TLS error. The retry absorbs the warmup; warm containers connect on the first attempt, so it costs nothing once running. Run `docker compose -f test-docker/docker-compose.yml up -d ftp ftp-pure` first.

Run: `docker compose -f test-docker/docker-compose.yml up -d ftp ftp-pure web`, then `npx jest --config jest.docker.config.js -- docker-ftp`.
