# Project Structure

Complete file listing for SSH Lite, organized by component.

---

## Solution Layout

```
SSHLite/
  package.json                            # Extension manifest, commands, settings, menus
  tsconfig.json                           # TypeScript config (ES2022, CommonJS)
  jest.config.js                          # Jest test config (unit tests)
  CLAUDE.md                               # AI assistant entry point
  .adn/                                   # Deep documentation (this folder)
  src/
    extension.ts                          # Activation, command registration, wiring (~2877 lines)
    types.ts                              # Core interfaces and error types (171 lines)
    connection/
      ConnectionManager.ts                # Multi-connection orchestration, auto-reconnect (~613 lines)
      ConnectionManager.test.ts           # Connection lifecycle, reconnect tests
      SSHConnection.ts                    # SSH/SFTP operations, host key verify (~1481 lines)
      SSHConnection.test.ts               # SSH operation tests
    services/
      FileService.ts                      # File ops, upload state, auto-sync, backups (~4097 lines)
      FileService.test.ts                 # File service unit tests
      FileService.crud.test.ts            # CRUD operation tests
      FileService.uploadstate.test.ts     # Upload state machine tests
      HostService.ts                      # SSH config parsing, host management
      HostService.test.ts                 # Host service tests
      CredentialService.ts                # SecretStorage credentials, pinned folders
      CredentialService.test.ts           # Credential tests
      CredentialService.pinned.test.ts    # Pinned folder tests
      TerminalService.ts                  # SSH terminal creation
      TerminalService.test.ts             # Terminal tests
      PortForwardService.ts               # Local/remote port forwarding
      PortForwardService.test.ts          # Port forward tests
      AuditService.ts                     # JSON line audit logging
      AuditService.test.ts                # Audit tests
      ActivityService.ts                  # Operation tracking, grouping
      ActivityService.test.ts             # Activity tests
      ServerMonitorService.ts             # Server diagnostics (quick status, watch)
      ServerMonitorService.test.ts        # Monitor tests
      CommandGuard.ts                     # Man-in-the-middle activity tracking
      CommandGuard.test.ts                # CommandGuard tests
      FolderHistoryService.ts             # Folder access history for preloading
      FolderHistoryService.test.ts        # Folder history tests
      ProgressiveDownloadManager.ts       # Large file progressive download
      ProgressiveDownloadManager.test.ts  # Progressive download tests
      PriorityQueueService.ts             # Priority queue for preloading
      PriorityQueueService.test.ts        # Priority queue tests
    providers/
      HostTreeProvider.ts                 # SSH hosts tree (Server > User > PinnedFolder)
      HostTreeProvider.test.ts            # Host tree tests
      FileTreeProvider.ts                 # Remote file browser tree (~2013 lines)
      FileTreeProvider.test.ts            # File tree tests
      FileDecorationProvider.ts           # Tab badges (↑ ✗ M), filter decorations
      FileDecorationProvider.test.ts      # Decoration tests
      ActivityTreeProvider.ts             # Activity panel tree
      ActivityTreeProvider.test.ts        # Activity tree tests
      PortForwardTreeProvider.ts          # Port forward panel tree
      PortForwardTreeProvider.test.ts     # Port forward tree tests
      SearchResultsProvider.ts            # Search results tree (deprecated - webview used)
      SearchResultsProvider.test.ts       # Search results tests
      ProgressiveFileContentProvider.ts   # Custom URI scheme for previews
      ProgressiveFileContentProvider.test.ts
    webviews/
      SearchPanel.ts                      # Cross-server search webview
      SearchPanel.test.ts                 # Search panel tests
    types/
      progressive.ts                      # Progressive download types
      progressive.test.ts                 # Progressive type tests
    utils/
      helpers.ts                          # formatFileSize, formatRelativeTime, normalizeLocalPath
      helpers.test.ts                     # Helper tests
      connectionPrefix.ts                 # Connection ID prefix utilities
      extensionHelpers.ts                 # parseHostInfoFromPath, isInSshTempDir, hasSshPrefix
    __mocks__/
      vscode.ts                           # Mock VS Code API for tests
      testHelpers.ts                      # Factory functions for test data
    integration/
      docker-ssh.test.ts                  # Docker-based SSH integration tests
      multi-server.test.ts                # Multi-server integration tests
      multi-os-ssh.test.ts                # Multi-OS SSH tests
      multios-monitor.test.ts             # Multi-OS monitor tests
      multios-commandguard.test.ts        # Multi-OS CommandGuard tests
      multios-auth.test.ts                # Multi-OS auth tests
      multios-connection.test.ts          # Multi-OS connection tests
      multios-fileops.test.ts             # Multi-OS file operation tests
      multios-helpers.ts                  # Multi-OS test helper utilities
  test-docker/                            # Docker compose for integration tests
  images/                                 # Extension icon
  out/                                    # Compiled JavaScript output
```

---

## File Counts

| Category | Files | Test Files |
|----------|-------|------------|
| Connection | 2 | 2 |
| Services | 12 | 14 |
| Providers | 6 | 6 |
| Webviews | 1 | 1 |
| Types | 2 | 1 |
| Utils | 3 | 1 |
| Mocks | 2 | -- |
| Integration | -- | 8 |
| Entry point | 1 | 1 |
| **Total** | **29** | **34** |

---

## Key File Sizes (by complexity)

| File | Approx Lines | Role |
|------|-------------|------|
| `extension.ts` | ~2877 | Largest: all command handlers, wiring |
| `FileService.ts` | ~4097 | File operations, upload state, backups |
| `FileTreeProvider.ts` | ~2013 | File browser tree, caching, filtering |
| `SSHConnection.ts` | ~1481 | SSH/SFTP operations |
| `ConnectionManager.ts` | ~613 | Multi-connection management |
| `SearchPanel.ts` | — | Webview HTML generation + messaging |
| `HostTreeProvider.ts` | — | Host tree hierarchy |
| `CredentialService.ts` | — | Credential storage |

---

## Tree Views (4 panels)

| View ID | Provider | Panel Name |
|---------|----------|------------|
| `sshLite.hosts` | HostTreeProvider | SSH Connections |
| `sshLite.fileExplorer` | FileTreeProvider | File Explorer |
| `sshLite.activity` | ActivityTreeProvider | Activity |
| `sshLite.portForwards` | PortForwardTreeProvider | Port Forwards |
