# SSH Lite -- Planned / TODO

## FTP Support (issue #9)
- Add FTP as a second connection type alongside SSH/SFTP
- Reuse existing file tree UI (FileTreeProvider is protocol-agnostic)
- Transport: `basic-ftp` npm package (or similar)
- New: FTPConnection class parallel to SSHConnection, FTP host config type, auth (user/password, anonymous)
- No VS Code server required on remote -- fits the server-lite philosophy

## Import / Export / Sync Connections (issue #11)
- Export all connection configs to a JSON file (right-click on Hosts panel or via Command Palette)
- Import connections from a JSON file (merge or replace)
- Optional: sync via Google Drive / Dropbox by pointing to a file path the user manages
- Credentials are excluded from export (stored separately in VS Code secret storage); only host metadata (host, port, username, label, paths) is exported

## Improve Diagnostic Logging
- Log all parameters and return values at entry/exit points of key functions
- Covers: connection lifecycle, file operations, command execution, tree provider updates
- Use `diagLog` (gated by `sshLite.diagnosticLogging`) for high-frequency paths; `infoLog` for state transitions
- Include timing (duration ms) for every async operation: connect, file read/write, command exec, SFTP ops
- Log command execution time per command so slow/timeout-prone servers are visible in the output channel
