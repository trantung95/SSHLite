# SSH Lite -- Planned / TODO

## FTP Support (issue #9)
- Add FTP as a second connection type alongside SSH/SFTP
- Reuse existing file tree UI (FileTreeProvider is protocol-agnostic)
- Transport: `basic-ftp` npm package (or similar)
- New: FTPConnection class parallel to SSHConnection, FTP host config type, auth (user/password, anonymous)
- No VS Code server required on remote -- fits the server-lite philosophy

## Improve Diagnostic Logging
- Log all parameters and return values at entry/exit points of key functions
- Covers: connection lifecycle, file operations, command execution, tree provider updates
- Use `diagLog` (gated by `sshLite.diagnosticLogging`) for high-frequency paths; `infoLog` for state transitions
- Include timing (duration ms) for async operations: connect, file read/write, command exec
