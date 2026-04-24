# SSH Lite (SSH Tools) — Command Reference

> Auto-generated from `package.json`. Run `npm run docs:commands` to regenerate.
> Last updated: 2026-04-24 · Version: 0.7.1

This document lists every command registered by SSH Lite (SSH Tools), organized by category.
Open the Command Palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) and type the command title to find it.

---

## Table of Contents

- [SSH Lite](#ssh-lite)
- [SSH Tools](#ssh-tools)

---

## SSH Lite {#ssh-lite}

| Command | ID | Keybinding | Where |
|---------|-----|-----------|-------|
| Connect to Host | `sshLite.connect` | `ctrl+shift+c / cmd+shift+c (Mac)` | Keybinding: ctrl+shift+c / cmd+shift+c (Mac) |
| Disconnect | `sshLite.disconnect` | — | Tree context menu |
| Enable Sudo Mode | `sshLite.enableSudoMode` | — | Tree context menu |
| Disable Sudo Mode | `sshLite.disableSudoMode` | — | Tree context menu |
| Add SSH Host | `sshLite.addHost` | — | View toolbar |
| Edit Host | `sshLite.editHost` | — | Tree context menu |
| Remove Host | `sshLite.removeHost` | — | Tree context menu |
| Rename Host | `sshLite.renameHost` | — | Tree context menu |
| Set Tab Label | `sshLite.setTabLabel` | — | Tree context menu |
| Refresh Hosts | `sshLite.refreshHosts` | — | View toolbar |
| Go to Path... | `sshLite.goToPath` | `ctrl+shift+g / cmd+shift+g (Mac)` | Keybinding: ctrl+shift+g / cmd+shift+g (Mac), View toolbar |
| Go to Parent Folder | `sshLite.goToParent` | — | View toolbar |
| Go to Home (~) | `sshLite.goToHome` | — | View toolbar |
| Go to Root (/) | `sshLite.goToRoot` | — | View toolbar |
| Open File | `sshLite.openFile` | — | Tree context menu |
| Download File | `sshLite.downloadFile` | — | Tree context menu |
| Upload File | `sshLite.uploadFile` | — | Tree context menu |
| Delete | `sshLite.deleteRemote` | — | Tree context menu |
| Rename | `sshLite.renameRemote` | `f2` | Keybinding: f2, Tree context menu |
| Move To... | `sshLite.moveRemote` | — | Tree context menu |
| New Folder | `sshLite.createFolder` | — | Tree context menu |
| Refresh Files | `sshLite.refreshFiles` | `ctrl+shift+r / cmd+shift+r (Mac)` | Keybinding: ctrl+shift+r / cmd+shift+r (Mac), View toolbar |
| Open Terminal | `sshLite.openTerminal` | `ctrl+shift+t / cmd+shift+t (Mac)` | Keybinding: ctrl+shift+t / cmd+shift+t (Mac), Tree context menu |
| Forward Port | `sshLite.forwardPort` | — | View toolbar |
| Stop Forward | `sshLite.stopForward` | — | Tree context menu |
| Start Saved Forward | `sshLite.activateSavedForward` | — | Tree context menu |
| Delete Saved Forward | `sshLite.deleteSavedForward` | — | Tree context menu |
| Show Audit Log | `sshLite.showAuditLog` | — | Command Palette only |
| Export Audit Log | `sshLite.exportAuditLog` | — | Command Palette only |
| Clear Audit Log | `sshLite.clearAuditLog` | — | Command Palette only |
| Monitor Server | `sshLite.monitor` | — | Tree context menu |
| Reconnect to Server | `sshLite.reconnectOrphanedFile` | — | Command Palette only |
| Quick Status (runs 10+ server commands) | `sshLite.quickStatus` | — | Command Palette only |
| Diagnose Slowness | `sshLite.diagnoseSlowness` | — | Command Palette only |
| Clear Saved Credentials | `sshLite.clearCredentials` | — | Tree context menu |
| Add Credential | `sshLite.addCredential` | — | Command Palette only |
| Connect with Credential | `sshLite.connectWithCredential` | — | Tree context menu |
| Remove User | `sshLite.deleteCredential` | — | Tree context menu |
| Save Password | `sshLite.savePassword` | — | Tree context menu |
| Clear All Temp Files | `sshLite.clearAllTempFiles` | — | View toolbar |
| Clear Temp Files for Server | `sshLite.clearTempFilesForConnection` | — | Tree context menu |
| Open Temp Files Folder | `sshLite.openTempFolder` | — | View toolbar |
| Pin Folder to Credential | `sshLite.pinFolder` | — | Tree context menu |
| Connect to Pinned Folder | `sshLite.connectToPinnedFolder` | — | Command Palette only |
| Remove Pinned Folder | `sshLite.deletePinnedFolder` | — | Tree context menu |
| Rename Pinned Folder | `sshLite.renamePinnedFolder` | — | Tree context menu |
| Revert File to Previous Version | `sshLite.revertFile` | — | Command Palette only |
| Show File Backup History | `sshLite.showFileBackups` | — | Tree context menu |
| Show Server Backups | `sshLite.showServerBackups` | — | Tree context menu |
| Show Changes | `sshLite.showChanges` | — | Tree context menu |
| Clear Server Backups | `sshLite.clearServerBackups` | — | Command Palette only |
| Show Backup Logs | `sshLite.showBackupLogs` | — | Tree context menu |
| Open Server Backup Folder | `sshLite.openServerBackupFolder` | — | Tree context menu |
| Open Terminal Here | `sshLite.openTerminalHere` | — | Tree context menu |
| Refresh | `sshLite.refreshItem` | — | Tree context menu |
| Clear Cache (Factory Reset) | `sshLite.clearCache` | — | View toolbar |
| Filter Hosts | `sshLite.filterHosts` | — | View toolbar |
| Clear Host Filter | `sshLite.clearHostFilter` | — | View toolbar |
| Filter Files | `sshLite.filterFiles` | `ctrl+shift+f / cmd+shift+f (Mac)` | Keybinding: ctrl+shift+f / cmd+shift+f (Mac), View toolbar |
| Clear Filter | `sshLite.clearFilter` | — | Command Palette only |
| Search Server for Filter | `sshLite.searchServerForFilter` | — | View toolbar |
| Show Search | `sshLite.showSearch` | `ctrl+shift+s / cmd+shift+s (Mac)` | Keybinding: ctrl+shift+s / cmd+shift+s (Mac), View toolbar |
| Search Here | `sshLite.searchInScope` | — | Tree context menu |
| Filter by Name | `sshLite.filterFileNames` | — | Tree context menu |
| Clear Filename Filter | `sshLite.clearFilenameFilter` | — | View toolbar, Tree context menu |
| Cancel Search | `sshLite.cancelSearch` | — | Command Palette only |
| Cancel Preloading | `sshLite.cancelPreloading` | — | Command Palette only |
| Reveal in File Tree | `sshLite.revealInTree` | — | View toolbar |
| Reveal Search Result in File Tree | `sshLite.revealSearchResultInTree` | — | Command Palette only |
| Copy Path | `sshLite.copyPath` | — | Tree context menu |
| Copy Host | `sshLite.copyHost` | — | Tree context menu |
| View All Backups | `sshLite.showAllBackups` | — | Tree context menu |
| Cancel Activity | `sshLite.cancelActivity` | — | Tree context menu |
| Cancel All Activities | `sshLite.cancelAllActivities` | — | View toolbar |
| Cancel Server Activities | `sshLite.cancelServerActivities` | — | Tree context menu |
| Clear Activities | `sshLite.clearActivities` | — | View toolbar |
| Toggle Grouping (Server/Type) | `sshLite.toggleActivityGrouping` | — | View toolbar |
| Expand All | `sshLite.expandAll` | — | View toolbar |
| Expand to First Level | `sshLite.expandFirstLevel` | — | View toolbar |
| Collapse All | `sshLite.collapseAll` | — | View toolbar |
| Show Tree From Root | `sshLite.showTreeFromRoot` | — | Tree context menu |
| Copy | `sshLite.copyRemoteItem` | `ctrl+c / cmd+c (Mac)` | Keybinding: ctrl+c / cmd+c (Mac), Tree context menu |
| Cut | `sshLite.cutRemoteItem` | `ctrl+x / cmd+x (Mac)` | Keybinding: ctrl+x / cmd+x (Mac), Tree context menu |
| Paste | `sshLite.pasteRemoteItem` | `ctrl+v / cmd+v (Mac)` | Keybinding: ctrl+v / cmd+v (Mac), Tree context menu |
| Clear SSH Clipboard | `sshLite.clearRemoteClipboard` | — | Command Palette only |

## SSH Tools {#ssh-tools}

| Command | ID | Keybinding | Where |
|---------|-----|-----------|-------|
| Show Remote Processes | `sshLite.showRemoteProcesses` | — | Tree context menu |
| Manage Remote Service | `sshLite.manageRemoteService` | — | Tree context menu |
| Show Remote Environment | `sshLite.showRemoteEnv` | — | Tree context menu |
| Edit Remote Crontab | `sshLite.editRemoteCron` | — | Tree context menu |
| Save Remote Crontab | `sshLite.saveRemoteCron` | — | Command Palette only |
| Run Snippet | `sshLite.runSnippet` | — | Tree context menu |
| Add Snippet | `sshLite.addSnippet` | — | Command Palette only |
| Manage Snippets | `sshLite.manageSnippets` | — | Command Palette only |
| Batch Command on Hosts | `sshLite.batchRun` | — | Command Palette only |
| Run Local Script on Remote | `sshLite.runLocalScriptRemote` | — | Tree context menu |
| Generate SSH Key | `sshLite.generateSshKey` | — | Command Palette only |
| Push Public Key to Host | `sshLite.pushPubKeyToHost` | — | Tree context menu |
| Diff with Local File | `sshLite.diffWithLocal` | — | Tree context menu |

---

## Quick Reference by Feature

### SSH File Explorer

| Action | How |
|--------|-----|
| Browse remote files | Connect a host, then expand folders in the SSH Explorer sidebar |
| Open/edit a file | Click any file — it opens in VS Code. Save with **Ctrl+S** to write back |
| Upload a file | Right-click a remote folder → **Upload File** |
| Download a file/folder | Right-click → **Download File** |
| Create a folder | Right-click a folder → **Create Folder** |
| Rename / Move | Right-click → **Rename** (or **F2**) / **Move** |
| Delete | Right-click → **Delete** |
| Copy / Cut / Paste | Right-click → **Copy** (**Ctrl+C**) or **Cut** (**Ctrl+X**), then right-click destination → **Paste** (**Ctrl+V**) |
| Diff remote vs local | Right-click a file → **Diff with Local File** |

### SSH Tools (Utilities)

| Utility | Command |
|---------|---------|
| View and kill remote processes | **Show Remote Processes** |
| Manage systemd services | **Manage Remote Service** |
| Inspect environment variables | **Show Remote Environment** |
| View/edit crontab | **Edit Remote Crontab** → **Save Remote Crontab** |
| Run a saved command snippet | **Run Snippet** |
| Add a custom snippet | **Add Snippet** |
| Run a command on many hosts | **Batch Command on Hosts** |
| Run a local script on remote | **Run Local Script on Remote** |
| Generate an SSH key pair | **Generate SSH Key** |
| Install a public key on a host | **Push Public Key to Host** |

### Connection Management

| Action | How |
|--------|-----|
| Add a host | Click **+** in the SSH Hosts panel or run **Add SSH Host** |
| Connect | Click the host or run **Connect to Host** (**Ctrl+Shift+C**) |
| Open terminal | Click the terminal icon or **Ctrl+Shift+T** |
| Port forward | Run **Forward Port** |
| Monitor server | Right-click connected host → **Monitor Server** |

---

*This file is auto-generated. Do not edit by hand — run `npm run docs:commands` to refresh.*
