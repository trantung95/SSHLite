# SSH Lite (SSH Tools) — Command Reference

> Auto-generated from `package.json`. Run `npm run docs:commands` to regenerate.
> Last updated: 2026-06-06 · Version: 0.9.6

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
| Connect to Host | `sshLite.connect` | `ctrl+alt+d c / cmd+alt+d c (Mac)`<br>`ctrl+alt+k c / cmd+alt+k c (Mac)` | Keybinding: ctrl+alt+d c / cmd+alt+d c (Mac), ctrl+alt+k c / cmd+alt+k c (Mac) |
| Disconnect | `sshLite.disconnect` | — | Tree context menu |
| Enable Sudo Mode | `sshLite.enableSudoMode` | — | Tree context menu |
| Disable Sudo Mode | `sshLite.disableSudoMode` | — | Tree context menu |
| Add SSH Host | `sshLite.addHost` | `ctrl+alt+d a / cmd+alt+d a (Mac)`<br>`ctrl+alt+k a / cmd+alt+k a (Mac)` | Keybinding: ctrl+alt+d a / cmd+alt+d a (Mac), ctrl+alt+k a / cmd+alt+k a (Mac), View toolbar |
| Edit Host | `sshLite.editHost` | — | Tree context menu |
| Remove Host | `sshLite.removeHost` | — | Tree context menu |
| Rename Host | `sshLite.renameHost` | — | Tree context menu |
| Set Tab Label | `sshLite.setTabLabel` | — | Tree context menu |
| Refresh Hosts | `sshLite.refreshHosts` | — | View toolbar |
| Go to Path... | `sshLite.goToPath` | `ctrl+alt+d g / cmd+alt+d g (Mac)`<br>`ctrl+alt+k g / cmd+alt+k g (Mac)` | Keybinding: ctrl+alt+d g / cmd+alt+d g (Mac), ctrl+alt+k g / cmd+alt+k g (Mac), View toolbar |
| Go to Parent Folder | `sshLite.goToParent` | `ctrl+alt+d u / cmd+alt+d u (Mac)`<br>`ctrl+alt+k u / cmd+alt+k u (Mac)` | Keybinding: ctrl+alt+d u / cmd+alt+d u (Mac), ctrl+alt+k u / cmd+alt+k u (Mac), View toolbar |
| Go to Home (~) | `sshLite.goToHome` | `ctrl+alt+d h / cmd+alt+d h (Mac)`<br>`ctrl+alt+k h / cmd+alt+k h (Mac)` | Keybinding: ctrl+alt+d h / cmd+alt+d h (Mac), ctrl+alt+k h / cmd+alt+k h (Mac), View toolbar |
| Go to Root (/) | `sshLite.goToRoot` | — | View toolbar |
| Open File | `sshLite.openFile` | — | Tree context menu |
| Download File | `sshLite.downloadFile` | — | Tree context menu |
| Upload File | `sshLite.uploadFile` | — | Tree context menu |
| Delete | `sshLite.deleteRemote` | `delete` | Keybinding: delete, Tree context menu |
| Rename | `sshLite.renameRemote` | `f2` | Keybinding: f2, Tree context menu |
| Move To... | `sshLite.moveRemote` | — | Tree context menu |
| New Folder | `sshLite.createFolder` | — | Tree context menu |
| New File | `sshLite.createFile` | — | Tree context menu |
| Save File as Root | `sshLite.saveAsRoot` | — | Command Palette only |
| Save File as User… | `sshLite.saveAsUser` | — | Command Palette only |
| New File as Root… | `sshLite.newFileAsRoot` | — | Tree context menu |
| Properties | `sshLite.showProperties` | — | Tree context menu |
| Refresh Files | `sshLite.refreshFiles` | `ctrl+alt+d r / cmd+alt+d r (Mac)`<br>`ctrl+alt+k r / cmd+alt+k r (Mac)` | Keybinding: ctrl+alt+d r / cmd+alt+d r (Mac), ctrl+alt+k r / cmd+alt+k r (Mac), View toolbar |
| Open Terminal | `sshLite.openTerminal` | `ctrl+alt+d t / cmd+alt+d t (Mac)`<br>`ctrl+alt+k t / cmd+alt+k t (Mac)` | Keybinding: ctrl+alt+d t / cmd+alt+d t (Mac), ctrl+alt+k t / cmd+alt+k t (Mac), Tree context menu |
| Forward Port | `sshLite.forwardPort` | `ctrl+alt+d p / cmd+alt+d p (Mac)`<br>`ctrl+alt+k p / cmd+alt+k p (Mac)` | Keybinding: ctrl+alt+d p / cmd+alt+d p (Mac), ctrl+alt+k p / cmd+alt+k p (Mac), View toolbar |
| Stop Forward | `sshLite.stopForward` | — | Tree context menu |
| Start Saved Forward | `sshLite.activateSavedForward` | — | Tree context menu |
| Delete Saved Forward | `sshLite.deleteSavedForward` | — | Tree context menu |
| Show Audit Log | `sshLite.showAuditLog` | — | Command Palette only |
| Export Audit Log | `sshLite.exportAuditLog` | — | Command Palette only |
| Clear Audit Log | `sshLite.clearAuditLog` | — | Command Palette only |
| Monitor Server | `sshLite.monitor` | `ctrl+alt+d m / cmd+alt+d m (Mac)`<br>`ctrl+alt+k m / cmd+alt+k m (Mac)` | Keybinding: ctrl+alt+d m / cmd+alt+d m (Mac), ctrl+alt+k m / cmd+alt+k m (Mac), Tree context menu |
| Reconnect to Server | `sshLite.reconnectOrphanedFile` | — | Command Palette only |
| Quick Status (runs 10+ server commands) | `sshLite.quickStatus` | `ctrl+alt+d q / cmd+alt+d q (Mac)`<br>`ctrl+alt+k q / cmd+alt+k q (Mac)` | Keybinding: ctrl+alt+d q / cmd+alt+d q (Mac), ctrl+alt+k q / cmd+alt+k q (Mac) |
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
| Filter Files | `sshLite.filterFiles` | `ctrl+alt+d f / cmd+alt+d f (Mac)`<br>`ctrl+alt+k f / cmd+alt+k f (Mac)` | Keybinding: ctrl+alt+d f / cmd+alt+d f (Mac), ctrl+alt+k f / cmd+alt+k f (Mac), View toolbar |
| Clear Filter | `sshLite.clearFilter` | — | Command Palette only |
| Search Server for Filter | `sshLite.searchServerForFilter` | — | View toolbar |
| Show Search | `sshLite.showSearch` | `ctrl+alt+d s / cmd+alt+d s (Mac)`<br>`ctrl+alt+k s / cmd+alt+k s (Mac)` | Keybinding: ctrl+alt+d s / cmd+alt+d s (Mac), ctrl+alt+k s / cmd+alt+k s (Mac), View toolbar |
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
| Report a Bug or Suggest a Feature | `sshLite.reportIssue` | — | Command Palette only |
| Donate (Keep This Project Independent) | `sshLite.donate` | — | Command Palette only |
| Star on GitHub | `sshLite.starGithub` | — | Command Palette only |
| Rate on Marketplace | `sshLite.rateMarketplace` | — | Command Palette only |
| Share Extension | `sshLite.shareExtension` | — | Command Palette only |

## SSH Tools {#ssh-tools}

| Command | ID | Keybinding | Where |
|---------|-----|-----------|-------|
| Show Remote Processes | `sshLite.showRemoteProcesses` | — | Tree context menu |
| Manage Remote Service | `sshLite.manageRemoteService` | — | Tree context menu |
| Show Remote Environment | `sshLite.showRemoteEnv` | `ctrl+alt+d e / cmd+alt+d e (Mac)`<br>`ctrl+alt+k e / cmd+alt+k e (Mac)` | Keybinding: ctrl+alt+d e / cmd+alt+d e (Mac), ctrl+alt+k e / cmd+alt+k e (Mac), Tree context menu |
| Edit Remote Crontab | `sshLite.editRemoteCron` | — | Tree context menu |
| Save Remote Crontab | `sshLite.saveRemoteCron` | — | Command Palette only |
| Run Snippet | `sshLite.runSnippet` | — | Tree context menu |
| Add Snippet | `sshLite.addSnippet` | — | Command Palette only |
| Manage Snippets | `sshLite.manageSnippets` | — | Command Palette only |
| Batch Command on Hosts | `sshLite.batchRun` | `ctrl+alt+d b / cmd+alt+d b (Mac)`<br>`ctrl+alt+k b / cmd+alt+k b (Mac)` | Keybinding: ctrl+alt+d b / cmd+alt+d b (Mac), ctrl+alt+k b / cmd+alt+k b (Mac) |
| Run Local Script on Remote | `sshLite.runLocalScriptRemote` | — | Tree context menu |
| Generate SSH Key | `sshLite.generateSshKey` | `ctrl+alt+d k / cmd+alt+d k (Mac)`<br>`ctrl+alt+k k / cmd+alt+k k (Mac)` | Keybinding: ctrl+alt+d k / cmd+alt+d k (Mac), ctrl+alt+k k / cmd+alt+k k (Mac) |
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
| Connect | Click the host or run **Connect to Host** (**Ctrl+Alt+D C** or **Ctrl+Alt+K C**) |
| Open terminal | Click the terminal icon or **Ctrl+Alt+D T** / **Ctrl+Alt+K T** |
| Port forward | Run **Forward Port** |
| Monitor server | Right-click connected host → **Monitor Server** |

---

*This file is auto-generated. Do not edit by hand — run `npm run docs:commands` to refresh.*
