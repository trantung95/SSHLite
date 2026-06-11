# SSH Lite -- Planned / TODO

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
