# Commands Reference

All 80+ commands registered by SSH Lite, organized by category.

---

## Command Categories

### Connection Commands

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.connect` | Connect to Host | Tree / Palette |
| `sshLite.disconnect` | Disconnect | Tree / Palette |
| `sshLite.connectWithCredential` | Connect with Credential | Tree context |
| `sshLite.reconnectOrphanedFile` | Reconnect Orphaned File | Editor title / context |

### Host Management

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.addHost` | Add SSH Host | View title |
| `sshLite.editHost` | Edit Host | Tree context |
| `sshLite.removeHost` | Remove Host | Tree context |
| `sshLite.renameHost` | Rename Host | Tree context |
| `sshLite.setTabLabel` | Set Tab Label | Tree context |
| `sshLite.refreshHosts` | Refresh Hosts | View title |
| `sshLite.filterHosts` | Filter Hosts | View title |
| `sshLite.clearHostFilter` | Clear Host Filter | View title |
| `sshLite.copyHost` | Copy Host Info | Tree context |

### Credential Management

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.addCredential` | Add Credential | Palette |
| `sshLite.deleteCredential` | Delete Credential | Tree context |
| `sshLite.savePassword` | Save Password | Tree context |
| `sshLite.clearCredentials` | Clear All Credentials | Tree context |

### Navigation

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.goToPath` | Go to Path | View title / Keybinding |
| `sshLite.goToParent` | Go to Parent | View title |
| `sshLite.goToHome` | Go to Home | View title |
| `sshLite.goToRoot` | Go to Root | View title |

### File Operations

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.openFile` | Open File | Tree context |
| `sshLite.downloadFile` | Download File | Tree context |
| `sshLite.uploadFile` | Upload File | Tree context |
| `sshLite.deleteRemote` | Delete | Tree context |
| `sshLite.renameRemote` | Rename | Tree context / Keybinding |
| `sshLite.moveRemote` | Move | Tree context |
| `sshLite.createFolder` | Create Folder | Tree context |
| `sshLite.refreshFiles` | Refresh Files | View title / Keybinding |
| `sshLite.refreshItem` | Refresh Item | Tree context |
| `sshLite.clearCache` | Clear Cache | View title |
| `sshLite.copyPath` | Copy Path | Tree context |
| `sshLite.revealInTree` | Reveal in Tree | View title / Editor title |

### Pinned Folders

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.pinFolder` | Pin Folder | Tree context |
| `sshLite.connectToPinnedFolder` | Connect to Pinned | Tree context |
| `sshLite.deletePinnedFolder` | Delete Pinned Folder | Tree context |
| `sshLite.renamePinnedFolder` | Rename Pinned Folder | Tree context |

### Terminal & Port Forward

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.openTerminal` | Open Terminal | Tree context / Keybinding |
| `sshLite.openTerminalHere` | Open Terminal Here | Tree context |
| `sshLite.forwardPort` | Forward Port | View title |
| `sshLite.stopForward` | Stop Forward | Tree context |

### Search & Filter

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.showSearch` | Show Search Panel | View title / Keybinding |
| `sshLite.searchInScope` | Search in Scope | Tree context |
| `sshLite.cancelSearch` | Cancel Search | Palette |
| `sshLite.filterFiles` | Filter Files (content) | View title / Keybinding |
| `sshLite.clearFilter` | Clear Filter | View title |
| `sshLite.filterFileNames` | Filter by Filename | Tree context (connection + folder) |
| `sshLite.clearFilenameFilter` | Clear Filename Filter | View title / Tree context |
| `sshLite.searchServerForFilter` | Search Server for Filter | View title |
| `sshLite.revealSearchResultInTree` | Reveal Search Result | Context |

### Change Tracking & Backups

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.revertFile` | Revert File | Palette |
| `sshLite.showFileBackups` | Show File Backups | Tree context |
| `sshLite.showServerBackups` | Show Server Backups | Tree context |
| `sshLite.showChanges` | Show Changes (diff) | Tree context |
| `sshLite.clearServerBackups` | Clear Server Backups | Palette |
| `sshLite.showBackupLogs` | Show Backup Logs | Tree context |
| `sshLite.openServerBackupFolder` | Open Backup Folder | Tree context |
| `sshLite.showAllBackups` | Show All Backups | Tree context |

### Server Monitoring

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.monitor` | Server Monitor | Tree context |
| `sshLite.quickStatus` | Quick Status | Palette |
| `sshLite.diagnoseSlowness` | Diagnose Slowness | Palette |

### Audit

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.showAuditLog` | Show Audit Log | Palette |
| `sshLite.exportAuditLog` | Export Audit Log | Palette |
| `sshLite.clearAuditLog` | Clear Audit Log | Palette |

### Activity Panel

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.cancelActivity` | Cancel Activity | Tree context |
| `sshLite.cancelAllActivities` | Cancel All Activities | View title |
| `sshLite.cancelServerActivities` | Cancel Server Activities | Tree context |
| `sshLite.clearActivities` | Clear Activities | View title |
| `sshLite.toggleActivityGrouping` | Toggle Grouping | View title |

### Temp Files

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.clearAllTempFiles` | Clear All Temp Files | View title |
| `sshLite.clearTempFilesForConnection` | Clear Temp Files (server) | Tree context |
| `sshLite.openTempFolder` | Open Temp Folder | View title |

### Tree Expand/Collapse

| Command | Title | Source |
|---------|-------|--------|
| `sshLite.expandAll` | Expand All | View title |
| `sshLite.expandFirstLevel` | Expand First Level | View title |
| `sshLite.collapseAll` | Collapse All | View title |
| `sshLite.cancelPreloading` | Cancel Preloading | Status bar |

---

## Context Value Reference

Tree item `contextValue` determines which menu items appear. These values are matched by regex in package.json `when` clauses.

### Host Tree

| contextValue | Represents |
|-------------|------------|
| `server` | Disconnected SSH config server |
| `savedServer` | Disconnected saved server |
| `connectedServer.saved` | Connected saved server |
| `connectedServer.config` | Connected SSH config server |
| `credential` | Disconnected user/credential |
| `credentialConnected` | Connected user/credential |
| `pinnedFolder` | Pinned folder (disconnected) |
| `pinnedFolderConnected` | Pinned folder (connected) |
| `addCredential` | "+ Add User..." item |

### File Tree

| contextValue | Represents |
|-------------|------------|
| `connection` | Connection root item |
| `folder` | Regular folder |
| `folder.filtered` | Folder with filename filter |
| `file` | Regular file |
| `file.filtered` | File matching filter |

### Activity Tree

| contextValue | Represents |
|-------------|------------|
| `activity.inProgress` | Running activity |
| `activity.completed` | Finished activity |
| `activity.failed` | Failed activity |
| `serverGroup` | Server group header |

### Port Forward Tree

| contextValue | Represents |
|-------------|------------|
| `portForward` | Active port forward |

---

## Keybindings

| Key | Command | When |
|-----|---------|------|
| `Ctrl+Shift+P` | (default) | VS Code command palette |
| Custom bindings in `contributes.keybindings` | Connect, Terminal, Refresh, etc. | Various |
