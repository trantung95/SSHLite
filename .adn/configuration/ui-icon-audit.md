# Kiểm tra ngôn ngữ icon Secure Shell (SSH) Lite

- **Ngày kiểm tra:** 2026-08-11
- **Phiên bản sản phẩm:** 1.0.6
- **Phiên bản Visual Studio Code (VS Code) tối thiểu:** 1.85.0
- **Catalog tương thích đã đối chiếu:** source VS Code 1.85.2
- **Phạm vi:** 117 command trong manifest và toàn bộ mapping icon lập trình của bốn native tree provider
- **Trạng thái:** inventory tự động đã hoàn tất; chưa kiểm tra thủ công giao diện đồ họa trong Extension Development Host

## Nguồn và phương pháp

1. Command identifier, title và icon được lấy trực tiếp từ `package.json.contributes.commands`.
2. Mapping runtime được lấy trực tiếp từ `HostTreeProvider.ts`, `FileTreeProvider.ts`, `ActivityTreeProvider.ts` và `PortForwardTreeProvider.ts`.
3. Khả năng tương thích Codicon được khóa bởi `src/__tests__/ui-manifest-contract.test.ts` theo source VS Code 1.85.2.
4. Slot inline, row target và collision được khóa bởi `src/__tests__/ui-manifest-contract.test.ts` cùng `src/__tests__/ftp-menu-gating.test.ts`.
5. Title trong bảng command được chép nguyên văn từ manifest; bảng này là inventory phát hành, không phải bản dịch.

File Transfer Protocol (FTP) dùng icon protocol group `cloud` trong source 1.0.6; Secure Shell dùng `remote`. Đây là mapping thực tế đã phát hành. Bốn provider không gán đường dẫn icon tùy chỉnh: mọi row dùng `ThemeIcon`, `ThemeIcon.File` hoặc `ThemeIcon.Folder`. `setFileTreeExtensionPath()` là no-op tương thích activation; `setExtensionPath()` không tạo mapping icon.

## Inventory 117 command

| # | Command | Shipped title | Codicon |
|---:|---|---|---|
| 1 | `sshLite.exportConnections` | Export Connections... | `export` |
| 2 | `sshLite.importConnections` | Import Connections... | `arrow-circle-down` |
| 3 | `sshLite.connectGoogleDrive` | Connect Google Drive (coming soon) | `sign-in` |
| 4 | `sshLite.disconnectGoogleDrive` | Disconnect Google Drive (coming soon) | `sign-out` |
| 5 | `sshLite.syncPushToDrive` | Sync: Push Connections to Google Drive (coming soon) | `cloud-upload` |
| 6 | `sshLite.syncPullFromDrive` | Sync: Pull Connections from Google Drive (coming soon) | `cloud-download` |
| 7 | `sshLite.connect` | Connect to Host | `plug` |
| 8 | `sshLite.disconnect` | Disconnect | `debug-disconnect` |
| 9 | `sshLite.enableSudoMode` | Enable Sudo Mode | `shield` |
| 10 | `sshLite.disableSudoMode` | Disable Sudo Mode | `shield` |
| 11 | `sshLite.addHost` | Add SSH Host | `add` |
| 12 | `sshLite.editHost` | Edit Host | `edit` |
| 13 | `sshLite.removeHost` | Remove Host | `trash` |
| 14 | `sshLite.renameHost` | Rename Host | `edit` |
| 15 | `sshLite.setTabLabel` | Set Tab Label | `tag` |
| 16 | `sshLite.refreshHosts` | Refresh Hosts | `refresh` |
| 17 | `sshLite.hostsViewAsList` | View Hosts as List | `list-flat` |
| 18 | `sshLite.hostsViewAsTree` | View Hosts as Tree (group by protocol) | `list-tree` |
| 19 | `sshLite.goToPath` | Go to Path... | `folder-opened` |
| 20 | `sshLite.goToParent` | Go to Parent Folder | `arrow-up` |
| 21 | `sshLite.goToHome` | Go to Home (~) | `home` |
| 22 | `sshLite.goToRoot` | Go to Root (/) | `root-folder` |
| 23 | `sshLite.openFile` | Open File | `file` |
| 24 | `sshLite.downloadFile` | Download File | `cloud-download` |
| 25 | `sshLite.uploadFile` | Upload File | `cloud-upload` |
| 26 | `sshLite.deleteRemote` | Delete | `trash` |
| 27 | `sshLite.renameRemote` | Rename | `edit` |
| 28 | `sshLite.moveRemote` | Move To... | `move` |
| 29 | `sshLite.createFolder` | New Folder | `new-folder` |
| 30 | `sshLite.createFile` | New File | `new-file` |
| 31 | `sshLite.saveAsRoot` | Save File as Root | `shield` |
| 32 | `sshLite.saveAsUser` | Save File as User… | `person` |
| 33 | `sshLite.newFileAsRoot` | New File as Root… | `new-file` |
| 34 | `sshLite.showProperties` | Properties | `info` |
| 35 | `sshLite.refreshFiles` | Refresh Files | `refresh` |
| 36 | `sshLite.openTerminal` | Open Terminal | `terminal` |
| 37 | `sshLite.forwardPort` | Create Port Forward — Automatically Save Rule | `add` |
| 38 | `sshLite.stopForward` | Stop Port Forward — Keep Saved Rule | `close` |
| 39 | `sshLite.activateSavedForward` | Start Saved Forward | `play` |
| 40 | `sshLite.deleteSavedForward` | Delete Saved Rule Permanently | `trash` |
| 41 | `sshLite.showAuditLog` | Show Audit Log | `output` |
| 42 | `sshLite.exportAuditLog` | Export Audit Log | `export` |
| 43 | `sshLite.clearAuditLog` | Clear Audit Log | `clear-all` |
| 44 | `sshLite.monitor` | Monitor Server | `pulse` |
| 45 | `sshLite.reconnectOrphanedFile` | Reconnect to Server | `plug` |
| 46 | `sshLite.quickStatus` | Quick Status (runs 10+ server commands) | `dashboard` |
| 47 | `sshLite.diagnoseSlowness` | Diagnose Slowness | `pulse` |
| 48 | `sshLite.clearCredentials` | Clear Saved Credentials | `trash` |
| 49 | `sshLite.addCredential` | Add Credential | `add` |
| 50 | `sshLite.connectWithCredential` | Connect with Credential | `plug` |
| 51 | `sshLite.deleteCredential` | Remove User | `trash` |
| 52 | `sshLite.savePassword` | Save Password | `save` |
| 53 | `sshLite.clearAllTempFiles` | Clear All Temp Files | `trash` |
| 54 | `sshLite.clearTempFilesForConnection` | Clear Temp Files for Server | `trash` |
| 55 | `sshLite.openTempFolder` | Open Temp Files Folder | `folder-opened` |
| 56 | `sshLite.pinFolder` | Pin Folder to Credential | `pin` |
| 57 | `sshLite.connectToPinnedFolder` | Connect to Pinned Folder | `plug` |
| 58 | `sshLite.deletePinnedFolder` | Remove Pinned Folder | `close` |
| 59 | `sshLite.renamePinnedFolder` | Rename Pinned Folder | `edit` |
| 60 | `sshLite.revertFile` | Revert File to Previous Version | `history` |
| 61 | `sshLite.showFileBackups` | Show File Backup History | `history` |
| 62 | `sshLite.showServerBackups` | Show Server Backups | `archive` |
| 63 | `sshLite.showChanges` | Show Changes | `diff` |
| 64 | `sshLite.clearServerBackups` | Clear Server Backups | `trash` |
| 65 | `sshLite.showBackupLogs` | Show Backup Logs | `output` |
| 66 | `sshLite.openServerBackupFolder` | Open Server Backup Folder | `folder-library` |
| 67 | `sshLite.openTerminalHere` | Open Terminal Here | `terminal` |
| 68 | `sshLite.refreshItem` | Refresh | `refresh` |
| 69 | `sshLite.clearCache` | Clear Cache (Factory Reset) | `clear-all` |
| 70 | `sshLite.filterHosts` | Filter Hosts | `filter` |
| 71 | `sshLite.clearHostFilter` | Clear Host Filter | `close` |
| 72 | `sshLite.filterFiles` | Filter Loaded Files by Name | `filter` |
| 73 | `sshLite.clearFilter` | Clear Filter | `close` |
| 74 | `sshLite.searchServerForFilter` | Deep Scan Current Filter — Add Matches to Remote Files | `remote-explorer` |
| 75 | `sshLite.showSearch` | Advanced Search — Content, Filenames, Scopes, and Servers | `search` |
| 76 | `sshLite.searchInScope` | Search Here | `search` |
| 77 | `sshLite.indexFolder` | Index Folder for Fast Filename Search | `database` |
| 78 | `sshLite.filterFileNames` | Filter by Name | `filter` |
| 79 | `sshLite.clearFilenameFilter` | Clear Filename Filter | `close` |
| 80 | `sshLite.cancelSearch` | Cancel Search | `search-stop` |
| 81 | `sshLite.cancelPreloading` | Cancel Preloading | `close` |
| 82 | `sshLite.revealInTree` | Reveal in File Tree | `target` |
| 83 | `sshLite.revealSearchResultInTree` | Reveal Search Result in File Tree | `go-to-file` |
| 84 | `sshLite.copyPath` | Copy Path | `copy` |
| 85 | `sshLite.copyHost` | Copy Host | `copy` |
| 86 | `sshLite.showAllBackups` | View All Backups | `archive` |
| 87 | `sshLite.cancelActivity` | Cancel Activity | `stop` |
| 88 | `sshLite.cancelAllActivities` | Cancel All Activities | `stop-circle` |
| 89 | `sshLite.cancelServerActivities` | Cancel Server Activities | `stop` |
| 90 | `sshLite.clearActivities` | Clear Activity List — Running Operations Continue | `clear-all` |
| 91 | `sshLite.toggleActivityGrouping` | Toggle Grouping (Server/Type) | `list-tree` |
| 92 | `sshLite.expandAll` | Expand All | `expand-all` |
| 93 | `sshLite.expandFirstLevel` | Expand to First Level | `fold-down` |
| 94 | `sshLite.collapseAll` | Collapse All | `collapse-all` |
| 95 | `sshLite.showTreeFromRoot` | Show Tree From Root | `list-tree` |
| 96 | `sshLite.copyRemoteItem` | Copy | `copy` |
| 97 | `sshLite.cutRemoteItem` | Cut | `move` |
| 98 | `sshLite.pasteRemoteItem` | Paste | `clippy` |
| 99 | `sshLite.clearRemoteClipboard` | Clear SSH Clipboard | `clear-all` |
| 100 | `sshLite.showRemoteProcesses` | Show Remote Processes | `server-process` |
| 101 | `sshLite.manageRemoteService` | Manage Remote Service | `gear` |
| 102 | `sshLite.showRemoteEnv` | Show Remote Environment | `symbol-variable` |
| 103 | `sshLite.editRemoteCron` | Edit Remote Crontab | `calendar` |
| 104 | `sshLite.saveRemoteCron` | Save Remote Crontab | `save` |
| 105 | `sshLite.runSnippet` | Run Snippet | `run` |
| 106 | `sshLite.addSnippet` | Add Snippet | `add` |
| 107 | `sshLite.manageSnippets` | Manage Snippets | `symbol-snippet` |
| 108 | `sshLite.batchRun` | Batch Command on Hosts | `terminal-bash` |
| 109 | `sshLite.runLocalScriptRemote` | Run Local Script on Remote | `play` |
| 110 | `sshLite.generateSshKey` | Generate SSH Key | `key` |
| 111 | `sshLite.pushPubKeyToHost` | Push Public Key to Host | `key` |
| 112 | `sshLite.diffWithLocal` | Diff with Local File | `diff` |
| 113 | `sshLite.reportIssue` | Report a Bug or Suggest a Feature | `bug` |
| 114 | `sshLite.donate` | Donate (Keep This Project Independent) | `heart` |
| 115 | `sshLite.starGithub` | Star on GitHub | `star` |
| 116 | `sshLite.rateMarketplace` | Rate on Marketplace | `feedback` |
| 117 | `sshLite.shareExtension` | Share Extension | `link` |

**Đối soát:** 117/117 command có đúng một row; 66 Codicon khác nhau. Không có placeholder hoặc command thiếu icon.

## Inventory mapping icon lập trình

| # | Module | Row hoặc helper | State | Icon | Theme color |
|---:|---|---|---|---|---|
| 1 | `HostTreeProvider` | `ServerTreeItem` | reconnecting | `server` | `charts.yellow` |
| 2 | `HostTreeProvider` | `ServerTreeItem` | connected with sudo | `shield` | `charts.yellow` |
| 3 | `HostTreeProvider` | `ServerTreeItem` | connected | `server` | `charts.green` |
| 4 | `HostTreeProvider` | `ServerTreeItem` | last connection failed | `server` | `charts.orange` |
| 5 | `HostTreeProvider` | `ServerTreeItem` | saved or disconnected | `server` | `default foreground` |
| 6 | `HostTreeProvider` | `NoHostsTreeItem` | empty | `server` | `default foreground` |
| 7 | `HostTreeProvider` | `UserCredentialTreeItem` | saved credential | `key` | `default foreground` |
| 8 | `HostTreeProvider` | `UserCredentialTreeItem` | no saved credential | `person` | `default foreground` |
| 9 | `HostTreeProvider` | `PinnedFolderTreeItem` | folder | `folder` | `default foreground` |
| 10 | `HostTreeProvider` | `AddCredentialTreeItem` | add account | `add` | `default foreground` |
| 11 | `HostTreeProvider` | `ProtocolGroupTreeItem` | Secure Shell | `remote` | `default foreground` |
| 12 | `HostTreeProvider` | `ProtocolGroupTreeItem` | File Transfer Protocol | `cloud` | `default foreground` |
| 13 | `FileTreeProvider` | `ConnectionTreeItem` | connected root | `remote` | `charts.green` |
| 14 | `FileTreeProvider` | `ReconnectingConnectionTreeItem` | reconnecting root | `sync~spin` | `charts.yellow` |
| 15 | `FileTreeProvider` | `ParentFolderTreeItem` | parent navigation | `arrow-up` | `default foreground` |
| 16 | `FileTreeProvider` | `FileTreeItem` | folder empty after filter | `folder` | `disabledForeground` |
| 17 | `FileTreeProvider` | `FileTreeItem` | highlighted folder | `folder` | `charts.yellow` |
| 18 | `FileTreeProvider` | `FileTreeItem` | normal folder | `ThemeIcon.Folder` | `product icon theme` |
| 19 | `FileTreeProvider` | `FileTreeItem` | loading file | `sync~spin` | `default foreground` |
| 20 | `FileTreeProvider` | `FileTreeItem` | highlighted file | `file` | `charts.yellow` |
| 21 | `FileTreeProvider` | `FileTreeItem` | file empty after filter | `file` | `disabledForeground` |
| 22 | `FileTreeProvider` | `FileTreeItem` | normal or open file | `file` | `default foreground` |
| 23 | `FileTreeProvider` | `LoadingTreeItem` | loading row | `sync~spin` | `default foreground` |
| 24 | `FileTreeProvider` | `LoadErrorTreeItem` | listing failed | `error` | `default foreground` |
| 25 | `FileTreeProvider` | `FilterResultsHeaderItem` | deep scan running | `sync~spin` | `default foreground` |
| 26 | `FileTreeProvider` | `FilterResultsHeaderItem` | deep scan results | `filter-filled` | `charts.blue` |
| 27 | `FileTreeProvider` | `FilteredFileItem` | deep scan result file | `ThemeIcon.File` | `product icon theme` |
| 28 | `FileTreeProvider` | `reconnecting header` | cached tree header | `sync~spin` | `default foreground` |
| 29 | `FileTreeProvider` | `reconnecting cached item` | folder | `folder` | `disabledForeground` |
| 30 | `FileTreeProvider` | `reconnecting cached item` | file | `file` | `disabledForeground` |
| 31 | `ActivityTreeProvider` | `ServerGroupTreeItem` | server group | `server` | `default foreground` |
| 32 | `ActivityTreeProvider` | `TypeGroupTreeItem` | search | `search` | `default foreground` |
| 33 | `ActivityTreeProvider` | `TypeGroupTreeItem` | download | `cloud-download` | `default foreground` |
| 34 | `ActivityTreeProvider` | `TypeGroupTreeItem` | upload | `cloud-upload` | `default foreground` |
| 35 | `ActivityTreeProvider` | `TypeGroupTreeItem` | directory load | `folder` | `default foreground` |
| 36 | `ActivityTreeProvider` | `TypeGroupTreeItem` | file refresh | `refresh` | `default foreground` |
| 37 | `ActivityTreeProvider` | `TypeGroupTreeItem` | preload | `loading` | `default foreground` |
| 38 | `ActivityTreeProvider` | `TypeGroupTreeItem` | monitor | `pulse` | `default foreground` |
| 39 | `ActivityTreeProvider` | `TypeGroupTreeItem` | terminal | `terminal` | `default foreground` |
| 40 | `ActivityTreeProvider` | `TypeGroupTreeItem` | connect | `plug` | `default foreground` |
| 41 | `ActivityTreeProvider` | `TypeGroupTreeItem` | disconnect | `debug-disconnect` | `default foreground` |
| 42 | `ActivityTreeProvider` | `TypeGroupTreeItem` | reveal | `target` | `default foreground` |
| 43 | `ActivityTreeProvider` | `ActivityTreeItem` | running | `sync~spin` | `default foreground` |
| 44 | `ActivityTreeProvider` | `ActivityTreeItem` | completed | `check` | `charts.green` |
| 45 | `ActivityTreeProvider` | `ActivityTreeItem` | cancelled | `circle-slash` | `charts.yellow` |
| 46 | `ActivityTreeProvider` | `ActivityTreeItem` | failed | `error` | `charts.red` |
| 47 | `ActivityTreeProvider` | `ActivityTreeItem` | fallback by activity type | `dynamic type mapping above` | `default foreground` |
| 48 | `ActivityTreeProvider` | `NoActivitiesTreeItem` | empty | `check-all` | `charts.green` |
| 49 | `PortForwardTreeProvider` | `PortForwardServerGroupTreeItem` | server group | `server` | `default foreground` |
| 50 | `PortForwardTreeProvider` | `PortForwardTreeItem` | active rule | `arrow-swap` | `charts.blue` |
| 51 | `PortForwardTreeProvider` | `NoPortForwardsTreeItem` | empty | `info` | `default foreground` |
| 52 | `PortForwardTreeProvider` | `SavedForwardTreeItem` | restore failed | `arrow-swap` | `charts.red` |
| 53 | `PortForwardTreeProvider` | `SavedForwardTreeItem` | saved, stopped, or disconnected | `arrow-swap` | `disabledForeground` |

**Đối soát:** 53/53 mapping state được inventory; mapping icon asset tùy chỉnh là 0.

## Mười ba command icon thay đổi so với 1.0.5

| Command | 1.0.5 | 1.0.6 | Lý do |
|---|---|---|---|
| `sshLite.importConnections` | `import` | `arrow-circle-down` | `import` không có trong VS Code 1.85.2. |
| `sshLite.forwardPort` | `arrow-right` | `add` | Hành động tạo port forward. |
| `sshLite.cancelSearch` | `stop` | `search-stop` | Giữ cả đối tượng search và hành động dừng. |
| `sshLite.cutRemoteItem` | `files` | `move` | Thể hiện kết quả cut rồi paste. |
| `sshLite.manageSnippets` | `list-tree` | `symbol-snippet` | Mô tả đúng snippet thay vì bố cục. |
| `sshLite.pushPubKeyToHost` | `cloud-upload` | `key` | Đối tượng chính là public key. |
| `sshLite.diagnoseSlowness` | `bug` | `pulse` | Chẩn đoán hiệu năng, không mặc định là lỗi phần mềm. |
| `sshLite.pinFolder` | `pinned` | `pin` | `pin` là hành động; `pinned` là state. |
| `sshLite.deletePinnedFolder` | `trash` | `close` | Chỉ bỏ liên kết, không xóa folder remote. |
| `sshLite.clearAuditLog` | `trash` | `clear-all` | Hành động clear nội dung log. |
| `sshLite.showBackupLogs` | `list-flat` | `output` | Mở log/output, không đổi kiểu tree. |
| `sshLite.showServerBackups` | `server` | `archive` | Đối tượng chính là backup archive. |
| `sshLite.manageRemoteService` | `server-environment` | `gear` | Quản lý service là cấu hình và vận hành. |

## Quy tắc đã khóa

- Giữ đúng 117 command identifier và số action nhìn thấy của 1.0.5.
- Hosts có 6 action header; Remote Files có 10, hoặc 11 khi filename filter active; Activity có 4; Port Forwards có 2.
- Inline parity: Remote Files connection/folder/file là `5/4/4`; Activity group/cancellable/completed là `1/1/0`; Port Forwards active/saved là `1/2`.
- Search dùng `search`; deep scan dùng `remote-explorer`; filter dùng `filter`; tree state dùng `expand-all`, `fold-down`, `collapse-all`.
- Màu chỉ bổ sung nghĩa. Label, description hoặc tooltip vẫn phải mô tả connected, reconnecting, failed, running, completed, cancelled, restore failed và disabled.
- Icon phải tồn tại trong VS Code 1.85.2; không nâng engine floor chỉ để lấy icon mới.
- Kiểm tra dark theme, light theme, keyboard, hover, selected, disabled, loading, empty, warning và error vẫn là bước thủ công chưa được thực hiện trong fix wave này.
