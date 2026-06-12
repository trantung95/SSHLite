# SSH Lite -- Planned / TODO

## Native search tools -- SHIPPED (core) in this change
- Per-connection auto-detection of ripgrep / fd / parallel-grep / mdfind / plocate (`sshLite.searchNativeTools`, default `auto`). Content search uses `rg --no-ignore --hidden` (grep parity) or `find -print0 | xargs -0 -P grep` on multi-core/busybox; filename search uses `fd` or `find -prune`; macOS uses `mdfind`. Universal `find -prune` + guarded `LC_ALL=C` apply on every server. Three-tier runtime fallback (detection / execution-stderr / degrade-and-remember) guarantees grep/find is always the safety net. Pure builders in `src/connection/searchCommandBuilder.ts`; fixed a latent busybox `grep --include` silent-0-results bug. Unit-tested (`searchCommandBuilder.test.ts` + SSHConnection native-tools tests); docker regression suite in `src/integration/docker-ssh-search-tools.test.ts` (run `npm run test:docker:search-tools`, needs Docker).

### FOLLOW-UP A -- Opt-in indexed filename search UI (plocate/locate) -- SHIPPED
- Webview toggle (`useIndexBtn`, ⚡) next to find-files in `webview-src/search/`, shown only in filename mode, default OFF per tab, NOT a persisted setting. `useIndex` flows through the `search` postMessage.
- `SSHConnection.searchIndexed(basePath, pattern, opts)` runs `buildLocateCommand`, anchors with `startsWith(basePath+'/')` AND a basename filter (matches live `find -iname`), returns the DB mtime (`stat -c %Y`). Returns null when no locate/DB → caller falls back. `SearchPanel.createSearchTask` surfaces the index age / "no file index — used live find" in the activity detail.
- Verified on the docker `search-tools` server (plocate + updatedb at build): indexed search finds seeded files, anchored + basename-matched, returns DB age; busybox returns null → falls back. Unit-tested in `SSHConnection.test.ts` ("searchIndexed").

### FOLLOW-UP B -- Client-side snapshot index (FilenameIndexService) -- SHIPPED
- `src/services/FilenameIndexService.ts` (singleton). Command `sshLite.indexFolder` ("Index Folder for Fast Filename Search", folder/connection context menu) runs ONE remote listing, gzips the path list into `globalStorage` keyed by stable `host:port:user::basePath`. Later filename searches (when ⚡ is on) match LOCALLY — 0 round-trips, works on ANY server incl. busybox. Snapshot age shown; live search stays default; a build that would hit `sshLite.filenameIndexMaxEntries` (default 2,000,000) is REFUSED, never truncated. Precedence in search: client snapshot → server plocate → live find. Command count 114→115 (synced across the 5 files). Unit-tested in `FilenameIndexService.test.ts`.

### FOLLOW-UP C -- Worker-pool sizing + future ideas
- (Considered, intentionally NOT done) clamp worker pool to server `nproc`: dropped as questionable-correctness — concurrent SSH channels hide latency regardless of server cores, and `xargs -P` already scales grep to cores server-side.
- Upload a static `rg` binary to opt-in hosts (VS Code Remote style) — only if a real request appears; conflicts with the "no server footprint" selling point.
- Self-learn the fastest strategy per host from logged `durationMs` — needs the broader "Improve Diagnostic Logging" timing work first.

## FTP Support (issue #9)
- Add FTP as a second connection type alongside SSH/SFTP
- Reuse existing file tree UI (FileTreeProvider is protocol-agnostic)
- Transport: `basic-ftp` npm package (or similar)
- New: FTPConnection class parallel to SSHConnection, FTP host config type, auth (user/password, anonymous)
- No VS Code server required on remote -- fits the server-lite philosophy

## Import / Export Connections (issue #11) -- SHIPPED in 0.10.0
- Export all connections (saved + ~/.ssh/config) to a JSON file. DONE.
- Import from a JSON file with a git-diff-style review UI (Current vs From file, per-connection radio, conflicts on top). DONE.
- Credentials excluded from export (only non-secret metadata + pinned folders); imported password credentials prompt on first connect. DONE.

## Google Drive sync (issue #11, part 2) -- COMING SOON (commands grayed out)
The full OAuth + Drive REST implementation is already in the codebase (`GoogleDriveSyncService`, `src/sync/googleOAuth.ts`, loopback + PKCE, raw Drive REST) and mock-tested. It is **disabled** (`isDriveConfigured()` is false; the four `*GoogleDrive*` / `*Drive` commands have `enablement: false` and a "(coming soon)" title) because it needs a one-time provisioning step:
- Create a Google Cloud project, enable the Google Drive API.
- Create an OAuth client of type **Desktop app**; configure the consent screen with ONLY the `drive.file` scope; publish to **In production** (while in "Testing", Google expires refresh tokens after 7 days).
- Paste the real `client_id` / `client_secret` into `src/sync/googleClient.ts` (replace the `__SET_ME__` placeholders).
- Then re-enable the commands: drop `enablement: false` + the "(coming soon)" title suffix in `package.json`, run `npm run docs:commands` + `npm run chaos:catalog`.
- Live-test the end-to-end sign-in (loopback browser consent), push, and pull on a second machine.
- See `.adn/features/connection-portability.md` for the full design.

## Improve Diagnostic Logging
- Log all parameters and return values at entry/exit points of key functions
- Covers: connection lifecycle, file operations, command execution, tree provider updates
- Use `diagLog` (gated by `sshLite.diagnosticLogging`) for high-frequency paths; `infoLog` for state transitions
- Include timing (duration ms) for every async operation: connect, file read/write, command exec, SFTP ops
- Log command execution time per command so slow/timeout-prone servers are visible in the output channel
