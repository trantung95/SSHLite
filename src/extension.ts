import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connection/ConnectionManager';
import { SSHConnection, setGlobalState } from './connection/SSHConnection';
import { HostService } from './services/HostService';
import { FileService } from './services/FileService';
import { TerminalService } from './services/TerminalService';
import { PortForwardService } from './services/PortForwardService';
import { CredentialService } from './services/CredentialService';
import { AuditService } from './services/AuditService';
import { ServerMonitorService, showMonitorQuickPick } from './services/ServerMonitorService';
import { FolderHistoryService } from './services/FolderHistoryService';
import { ProgressiveDownloadManager } from './services/ProgressiveDownloadManager';
import { HostTreeProvider, ServerTreeItem, UserCredentialTreeItem, CredentialTreeItem, PinnedFolderTreeItem, setExtensionPath } from './providers/HostTreeProvider';
import { SavedCredential, PinnedFolder } from './services/CredentialService';
import { IHostConfig, ConnectionState } from './types';
import { FileTreeProvider, FileTreeItem, ConnectionTreeItem, setFileTreeExtensionPath } from './providers/FileTreeProvider';
import { PortForwardTreeProvider, PortForwardTreeItem } from './providers/PortForwardTreeProvider';
import { ActivityTreeProvider, ActivityTreeItem, ServerGroupTreeItem } from './providers/ActivityTreeProvider';
import { ActivityService } from './services/ActivityService';
import { SearchPanel } from './webviews/SearchPanel';
import { SSHFileDecorationProvider } from './providers/FileDecorationProvider';
import { ProgressiveFileContentProvider } from './providers/ProgressiveFileContentProvider';
import { PROGRESSIVE_PREVIEW_SCHEME } from './types/progressive';
import { formatFileSize, formatRelativeTime, normalizeLocalPath } from './utils/helpers';
import { parseHostInfoFromPath as parseHostInfo, isInSshTempDir, hasSshPrefix } from './utils/extensionHelpers';

let outputChannel: vscode.OutputChannel;

/**
 * Helper to select a connection from quick pick
 */
async function selectConnection(connectionManager: ConnectionManager) {
  const connections = connectionManager.getAllConnections();
  if (connections.length === 0) {
    return undefined;
  }

  if (connections.length === 1) {
    return connections[0];
  }

  const selected = await vscode.window.showQuickPick(
    connections.map((c) => ({
      label: c.host.name,
      description: `${c.host.username}@${c.host.host}`,
      connection: c,
    })),
    {
      placeHolder: 'Select connection',
      ignoreFocusOut: true,
    }
  );

  return selected?.connection;
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('SSH Lite');
  log('SSH Lite extension activating...');

  // Get service instances
  const connectionManager = ConnectionManager.getInstance();
  const hostService = HostService.getInstance();
  const fileService = FileService.getInstance();
  const terminalService = TerminalService.getInstance();
  const portForwardService = PortForwardService.getInstance();
  const credentialService = CredentialService.getInstance();
  const auditService = AuditService.getInstance();
  const monitorService = ServerMonitorService.getInstance();

  // Initialize credential service with extension context
  credentialService.initialize(context);

  // Initialize host key verification storage
  setGlobalState(context.globalState);

  // Initialize folder history service for smart preloading
  const folderHistoryService = FolderHistoryService.getInstance();
  folderHistoryService.initialize(context);

  // Set extension path for custom icons
  setExtensionPath(context.extensionPath);
  setFileTreeExtensionPath(context.extensionPath);

  // Create tree providers
  const hostTreeProvider = new HostTreeProvider();
  const fileTreeProvider = new FileTreeProvider();
  const portForwardTreeProvider = new PortForwardTreeProvider();
  const activityTreeProvider = new ActivityTreeProvider();
  const activityService = ActivityService.getInstance();

  // Initialize progressive download system for large files
  const progressiveContentProvider = ProgressiveFileContentProvider.getInstance();
  const progressiveDownloadManager = ProgressiveDownloadManager.getInstance();
  progressiveDownloadManager.initialize(progressiveContentProvider);

  // Register progressive file content provider for preview URIs
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PROGRESSIVE_PREVIEW_SCHEME,
      progressiveContentProvider
    )
  );

  // Wire up port forward service with its tree provider
  portForwardService.setTreeProvider(portForwardTreeProvider);

  // Register tree views (showCollapseAll: false - we provide custom toggle buttons)
  const hostTreeView = vscode.window.createTreeView('sshLite.hosts', {
    treeDataProvider: hostTreeProvider,
    showCollapseAll: false,
  });

  const fileTreeView = vscode.window.createTreeView('sshLite.fileExplorer', {
    treeDataProvider: fileTreeProvider,
    showCollapseAll: false,
    dragAndDropController: fileTreeProvider,
    canSelectMany: true,
  });

  const portForwardTreeView = vscode.window.createTreeView('sshLite.portForwards', {
    treeDataProvider: portForwardTreeProvider,
    showCollapseAll: false,
  });

  const activityTreeView = vscode.window.createTreeView('sshLite.activity', {
    treeDataProvider: activityTreeProvider,
    showCollapseAll: false,
  });

  // Register file decoration provider for live-refresh tab indicators
  const fileDecorationProvider = new SSHFileDecorationProvider(fileService, connectionManager);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider),
    fileDecorationProvider
  );

  // Initialize expand/collapse toggle state for all tree views (all start collapsed)
  vscode.commands.executeCommand('setContext', 'sshLite.hosts.expanded', false);
  vscode.commands.executeCommand('setContext', 'sshLite.fileExplorer.expanded', false);
  vscode.commands.executeCommand('setContext', 'sshLite.activity.expanded', false);
  vscode.commands.executeCommand('setContext', 'sshLite.portForwards.expanded', false);

  // Track expand/collapse events for file tree to preserve expansion state
  context.subscriptions.push(
    fileTreeView.onDidExpandElement((e) => {
      fileTreeProvider.trackExpand(e.element);
      // When any item is expanded, show collapse button
      vscode.commands.executeCommand('setContext', 'sshLite.fileExplorer.expanded', true);
    }),
    fileTreeView.onDidCollapseElement((e) => {
      fileTreeProvider.trackCollapse(e.element);
    })
  );

  // Track expand events for other tree views to update toggle state
  context.subscriptions.push(
    hostTreeView.onDidExpandElement(() => {
      vscode.commands.executeCommand('setContext', 'sshLite.hosts.expanded', true);
    }),
    activityTreeView.onDidExpandElement(() => {
      vscode.commands.executeCommand('setContext', 'sshLite.activity.expanded', true);
    }),
    portForwardTreeView.onDidExpandElement(() => {
      vscode.commands.executeCommand('setContext', 'sshLite.portForwards.expanded', true);
    })
  );

  // Force initial refresh of host tree to ensure clean state on VS Code restart
  // This clears any cached icons from previous session
  setTimeout(() => {
    hostTreeProvider.refresh();
  }, 100);

  // Track orphaned SSH files from previous session (read-only until reconnected)
  // Maps local file path -> { remotePath, hostInfo (parsed from path) }
  const orphanedSshFiles = new Map<string, { remotePath: string; hostHash: string }>();

  // Check if a document is an orphaned SSH file
  const isOrphanedSshFile = (localPath: string): boolean => {
    return orphanedSshFiles.has(localPath);
  };

  // Parse host info from SSH temp file path (delegates to extracted helper)
  const parseHostInfoFromPath = (filePath: string): { hostHash: string; fileName: string } | null => {
    return parseHostInfo(filePath, fileService.getTempDir());
  };

  // Detect orphaned SSH files on startup
  const detectOrphanedSshFiles = () => {
    const sshTempDir = fileService.getTempDir();
    const openDocs = vscode.workspace.textDocuments;

    for (const doc of openDocs) {
      // Check if this is an SSH file
      const fsPath = normalizeLocalPath(doc.uri.fsPath);

      if ((isInSshTempDir(fsPath, sshTempDir) || hasSshPrefix(fsPath)) && !doc.isUntitled) {
        // Check if we have an active connection for it
        const mapping = fileService.getFileMapping(fsPath);
        if (!mapping) {
          // No mapping = orphaned file from previous session
          const hostInfo = parseHostInfoFromPath(fsPath);
          if (hostInfo) {
            orphanedSshFiles.set(fsPath, {
              remotePath: '', // We don't know the remote path yet
              hostHash: hostInfo.hostHash,
            });
            log(`Detected orphaned SSH file: ${fsPath} (hostHash: ${hostInfo.hostHash})`);
          }
        }
      }
    }

    if (orphanedSshFiles.size > 0) {
      log(`Found ${orphanedSshFiles.size} orphaned SSH file(s) from previous session`);
      vscode.window.setStatusBarMessage(
        `$(warning) ${orphanedSshFiles.size} SSH file(s) are read-only. Click "Reconnect" to enable editing.`,
        10000
      );
      // Update context for menu visibility
      vscode.commands.executeCommand('setContext', 'sshLite.hasOrphanedFiles', true);
    }
  };

  // Run detection after a short delay to let VS Code finish restoring tabs
  setTimeout(detectOrphanedSshFiles, 1000);

  // Create preload status bar item
  const preloadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  preloadStatusBar.name = 'SSH Lite Preload';
  preloadStatusBar.command = 'sshLite.cancelPreloading';
  preloadStatusBar.tooltip = 'Click to cancel preloading';
  context.subscriptions.push(preloadStatusBar);

  // Create SSH file info status bar item (shows when SSH file is active)
  const sshFileInfoStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sshFileInfoStatusBar.name = 'SSH Lite File Info';
  context.subscriptions.push(sshFileInfoStatusBar);

  // Update SSH file info when active editor changes
  const updateSshFileInfo = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      sshFileInfoStatusBar.hide();
      vscode.commands.executeCommand('setContext', 'sshLite.isConnectedFile', false);
      vscode.commands.executeCommand('setContext', 'sshLite.hasActiveRemoteFile', false);
      return;
    }

    const filePath = normalizeLocalPath(editor.document.uri.fsPath);
    const mapping = fileService.getFileMapping(filePath);

    // Set context for showing/hiding reconnect button
    const isConnected = !!mapping;
    vscode.commands.executeCommand('setContext', 'sshLite.isConnectedFile', isConnected);

    // Determine if this is a remote file (for reveal in tree button)
    // Check mapping first, then fall back to temp path structure
    let isRemoteFile = isConnected;
    if (!isRemoteFile) {
      const tempDir = fileService.getTempDir();
      if (filePath.startsWith(tempDir)) {
        const segments = filePath.substring(tempDir.length).split(/[/\\]/).filter(s => s.length > 0);
        if (segments.length >= 2) {
          const connectionId = segments[0];
          isRemoteFile = !!connectionManager.getConnection(connectionId);
        }
      }
    }
    vscode.commands.executeCommand('setContext', 'sshLite.hasActiveRemoteFile', isRemoteFile);

    if (mapping) {
      // Handle cases where remoteFile or connection might be undefined (preloaded files)
      if (mapping.remoteFile && mapping.connection) {
        const sizeStr = formatFileSize(mapping.remoteFile.size);
        const relativeTime = formatRelativeTime(mapping.remoteFile.modifiedTime);
        const hostName = mapping.connection.host.name;

        sshFileInfoStatusBar.text = `$(remote) ${hostName}`;
        sshFileInfoStatusBar.tooltip = [
          `Remote File: ${mapping.remoteFile.path}`,
          `Host: ${hostName}`,
          `Size: ${sizeStr}`,
          `Modified: ${relativeTime}`,
          `Connection: ${mapping.connection.host.host}:${mapping.connection.host.port}`,
        ].join('\n');
        sshFileInfoStatusBar.show();
      } else {
        // Fallback for preloaded files without full info
        sshFileInfoStatusBar.text = `$(remote) SSH File`;
        sshFileInfoStatusBar.tooltip = `Remote File: ${mapping.remotePath}`;
        sshFileInfoStatusBar.show();
      }
    } else {
      sshFileInfoStatusBar.hide();
    }
  };

  // Listen for active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateSshFileInfo)
  );

  // Initial update
  updateSshFileInfo();

  // Track preload progress with periodic updates
  let preloadProgressInterval: ReturnType<typeof setInterval> | null = null;

  function startPreloadProgressTracking(): void {
    if (preloadProgressInterval) {
      return;
    }

    preloadProgressInterval = setInterval(() => {
      const dirStatus = fileTreeProvider.getPreloadStatus();
      const fileStatus = fileService.getPreloadStatus();

      const totalActive = dirStatus.active + fileStatus.active;
      const totalQueued = dirStatus.queued;
      const totalCompleted = dirStatus.completed + fileStatus.completed;
      const totalTotal = dirStatus.total + fileStatus.total;

      if (totalActive > 0 || totalQueued > 0) {
        preloadStatusBar.text = `$(sync~spin) Preloading: ${totalCompleted}/${totalTotal} (${totalActive} active)`;
        preloadStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        preloadStatusBar.show();
      } else {
        preloadStatusBar.hide();
        if (preloadProgressInterval) {
          clearInterval(preloadProgressInterval);
          preloadProgressInterval = null;
        }
      }
    }, 2000); // LITE: Update every 2 seconds instead of 500ms
  }

  // Start tracking when connections exist
  connectionManager.onDidChangeConnections(() => {
    if (connectionManager.getAllConnections().length > 0) {
      startPreloadProgressTracking();
    }
  });

  // Clear cache on any disconnect (manual or unexpected)
  connectionManager.onConnectionStateChange((event) => {
    if (event.state === ConnectionState.Disconnected) {
      fileTreeProvider.clearCache(event.connection.id);
    }
  });

  // Register commands
  const commands = [
    // Host commands
    vscode.commands.registerCommand('sshLite.connect', async (item?: ServerTreeItem) => {
      try {
        let hostConfig: IHostConfig | undefined;

        if (item instanceof ServerTreeItem) {
          // From server tree - if multiple users, show picker; otherwise use first
          if (item.hosts.length === 1) {
            hostConfig = item.hosts[0];
          } else {
            const selected = await vscode.window.showQuickPick(
              item.hosts.map((h) => ({
                label: h.username,
                description: credentialService.listCredentials(h.id).length > 0 ? 'Password saved' : 'No password saved',
                host: h,
              })),
              {
                placeHolder: 'Select user to connect as',
                ignoreFocusOut: true,
              }
            );
            if (!selected) return;
            hostConfig = selected.host;
          }
        }

        if (!hostConfig) {
          // Show quick pick to select host
          const hosts = hostService.getAllHosts();
          if (hosts.length === 0) {
            const action = await vscode.window.showInformationMessage(
              'No SSH hosts found. Would you like to add one?',
              'Add Host'
            );
            if (action === 'Add Host') {
              await vscode.commands.executeCommand('sshLite.addHost');
            }
            return;
          }

          const selected = await vscode.window.showQuickPick(
            hosts.map((h) => ({
              label: h.name,
              description: `${h.username}@${h.host}:${h.port}`,
              host: h,
            })),
            {
              placeHolder: 'Select host to connect',
              ignoreFocusOut: true,
            }
          );

          if (!selected) {
            return;
          }

          hostConfig = selected.host;
        }

        logCommand('connect', `${hostConfig.username}@${hostConfig.host}:${hostConfig.port}`);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connect(hostConfig!);
          }
        );

        logResult('connect', true, `Connected to ${hostConfig.name}`);
        // Auto-dismiss connection success (non-blocking UX)
        vscode.window.setStatusBarMessage(`$(check) Connected to ${hostConfig.name}`, 3000);
      } catch (error) {
        const errMsg = (error as Error).message;
        logResult('connect', false, errMsg);
        // Provide actionable suggestions based on error type
        let suggestion = '';
        if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT')) {
          suggestion = ' Check if the server is running and the port is correct.';
        } else if (errMsg.includes('authentication') || errMsg.includes('password') || errMsg.includes('Permission denied')) {
          suggestion = ' Verify your username and password/key.';
        } else if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
          suggestion = ' Check the hostname - it may be misspelled or unreachable.';
        }
        vscode.window.showErrorMessage(`Connection failed: ${errMsg}${suggestion}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.disconnect', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connections: SSHConnection[] = [];

      if (item instanceof ConnectionTreeItem) {
        // From file explorer - single connection
        connections = [item.connection];
      } else if (item instanceof ServerTreeItem) {
        // From server tree - find all connections for this server
        for (const host of item.hosts) {
          const conn = connectionManager.getConnection(host.id);
          if (conn) {
            connections.push(conn);
          }
        }
      }

      if (connections.length === 0) {
        return;
      }

      // Disconnect all connections for this server
      for (const connection of connections) {
        logCommand('disconnect', connection.host.name);

        // Clean up resources
        fileService.cleanupConnection(connection.id);
        terminalService.closeTerminalsForConnection(connection.id);
        await portForwardService.stopAllForwardsForConnection(connection.id);
        fileTreeProvider.clearCache(connection.id);
        fileTreeProvider.clearExpansionState(connection.id);

        await connectionManager.disconnect(connection.id);
        logResult('disconnect', true, connection.host.name);
      }

      // Auto-dismiss disconnect success (non-blocking UX)
      const serverName = connections[0].host.name;
      vscode.window.setStatusBarMessage(`$(check) Disconnected from ${serverName}`, 3000);
    }),

    // Reconnect orphaned SSH file - connects to server and enables editing
    vscode.commands.registerCommand('sshLite.reconnectOrphanedFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const localPath = normalizeLocalPath(editor.document.uri.fsPath);
      const orphanInfo = orphanedSshFiles.get(localPath);

      if (!orphanInfo) {
        // Check if it's a regular SSH file that just needs the mapping restored
        const hostInfo = parseHostInfoFromPath(localPath);
        if (!hostInfo) {
          vscode.window.showWarningMessage('This is not an SSH file');
          return;
        }
      }

      // Get host hash from path
      const hostInfo = parseHostInfoFromPath(localPath);
      if (!hostInfo) {
        vscode.window.showWarningMessage('Cannot determine server from file path');
        return;
      }

      // Find matching host by comparing hashes
      const crypto = await import('crypto');
      const allHosts = hostService.getAllHosts();
      let matchingHost: IHostConfig | undefined;

      for (const host of allHosts) {
        const hostHash = crypto.createHash('md5').update(host.id).digest('hex').substring(0, 8);
        if (hostHash === hostInfo.hostHash) {
          matchingHost = host;
          break;
        }
      }

      if (!matchingHost) {
        // Show quick pick to let user select the host manually
        const selected = await vscode.window.showQuickPick(
          allHosts.map((h) => ({
            label: h.name,
            description: `${h.username}@${h.host}:${h.port}`,
            host: h,
          })),
          {
            placeHolder: 'Select the server this file belongs to',
            ignoreFocusOut: true,
          }
        );

        if (!selected) {
          return;
        }
        matchingHost = selected.host;
      }

      logCommand('reconnectOrphanedFile', `${matchingHost.name} for ${hostInfo.fileName}`);

      try {
        // Check if already connected
        let connection = connectionManager.getConnection(matchingHost.id);

        if (!connection) {
          // Need to connect first
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Connecting to ${matchingHost.name}...`,
              cancellable: false,
            },
            async () => {
              await connectionManager.connect(matchingHost!);
            }
          );
          connection = connectionManager.getConnection(matchingHost.id);
        }

        if (!connection) {
          throw new Error('Failed to establish connection');
        }

        // Try to get remote path from persisted metadata
        const metadata = fileService.getRemotePathFromMetadata(localPath);
        let remotePath: string | undefined;

        if (metadata?.remotePath) {
          // Use the stored remote path
          remotePath = metadata.remotePath;
        } else {
          // Fallback: ask user to provide the remote path
          const fileName = hostInfo.fileName;
          remotePath = await vscode.window.showInputBox({
            prompt: `Enter the remote path for "${fileName}"`,
            placeHolder: '/path/to/file',
            value: `~/${fileName}`, // Default guess
            ignoreFocusOut: true,
          });
        }

        if (!remotePath) {
          return;
        }

        // Verify the file exists on server
        const exists = await connection.fileExists(remotePath);
        if (!exists) {
          const action = await vscode.window.showWarningMessage(
            `File not found on server: ${remotePath}`,
            'Try Again',
            'Cancel'
          );
          if (action === 'Try Again') {
            await vscode.commands.executeCommand('sshLite.reconnectOrphanedFile');
          }
          return;
        }

        // Register the file mapping so it becomes editable
        const remoteFile = await connection.stat(remotePath);
        await fileService.registerExistingFile(localPath, connection, remoteFile);

        // Remove from orphaned list
        orphanedSshFiles.delete(localPath);
        if (orphanedSshFiles.size === 0) {
          vscode.commands.executeCommand('setContext', 'sshLite.hasOrphanedFiles', false);
        }

        // Reveal in file tree - navigate to parent folder and highlight the file
        const treeItem = await fileTreeProvider.revealFile(connection.id, remotePath);
        if (treeItem) {
          // Wait a bit for tree to render, then reveal with focus
          setTimeout(async () => {
            try {
              await fileTreeView.reveal(treeItem, { select: true, focus: true, expand: true });
            } catch {
              // Silently ignore reveal errors (item might not be rendered yet)
            }
          }, 300);
        }

        logResult('reconnectOrphanedFile', true, `${matchingHost.name}: ${remotePath}`);
        vscode.window.setStatusBarMessage(
          `$(check) Reconnected! File is now editable: ${remotePath}`,
          5000
        );

        // Refresh the editor to update any read-only decorations
        await vscode.commands.executeCommand('workbench.action.files.revert');

      } catch (error) {
        logResult('reconnectOrphanedFile', false, (error as Error).message);
        vscode.window.showErrorMessage(`Failed to reconnect: ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.addHost', async () => {
      logCommand('addHost');
      const host = await hostService.promptAddHost();
      if (host) {
        hostTreeProvider.refresh();
        logResult('addHost', true, host.name);
        vscode.window.setStatusBarMessage(`$(check) Added host: ${host.name}`, 3000);
      }
    }),

    vscode.commands.registerCommand('sshLite.editHost', async (item?: ServerTreeItem) => {
      if (!item) return;

      // Find the first saved host for this server to edit
      const savedHost = item.hosts.find(h => h.source === 'saved');
      if (!savedHost) {
        vscode.window.setStatusBarMessage('$(info) SSH config hosts must be edited in ~/.ssh/config', 5000);
        return;
      }

      const host = await hostService.promptEditHost(savedHost);
      if (host) {
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) Updated host: ${host.name}`, 3000);
      }
    }),

    vscode.commands.registerCommand('sshLite.removeHost', async (item?: ServerTreeItem) => {
      if (!item) return;

      // Find saved hosts for this server
      const savedHosts = item.hosts.filter(h => h.source === 'saved');
      if (savedHosts.length === 0) {
        vscode.window.setStatusBarMessage('$(info) SSH config hosts must be edited in ~/.ssh/config', 5000);
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove all saved users for "${item.primaryHost.name}"?`,
        { modal: true },
        'Remove'
      );

      if (confirm === 'Remove') {
        for (const host of savedHosts) {
          await hostService.removeHost(host.id);
        }
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) Removed saved users for: ${item.primaryHost.name}`, 3000);
      }
    }),

    vscode.commands.registerCommand('sshLite.refreshHosts', () => {
      hostTreeProvider.refresh();
    }),

    // Navigation commands
    vscode.commands.registerCommand('sshLite.goToPath', async (connectionOrItem?: SSHConnection | ConnectionTreeItem | FileTreeItem | IHostConfig, pathArg?: string) => {
      let connection: SSHConnection | undefined;

      // Handle different argument types
      if (connectionOrItem instanceof SSHConnection) {
        connection = connectionOrItem;
      } else if (connectionOrItem instanceof ConnectionTreeItem) {
        connection = connectionOrItem.connection;
      } else if (connectionOrItem instanceof FileTreeItem) {
        connection = connectionOrItem.connection;
      } else if (connectionOrItem && typeof connectionOrItem === 'object' && 'id' in connectionOrItem && 'host' in connectionOrItem) {
        // IHostConfig - look up connection by host ID
        connection = connectionManager.getConnection((connectionOrItem as IHostConfig).id);
        if (!connection) {
          vscode.window.showWarningMessage('Not connected to this host');
          return;
        }
      } else {
        // No argument - prompt user to select connection
        const conn = await selectConnection(connectionManager);
        if (!conn) return;
        connection = conn;
      }

      // Get target path
      let targetPath = pathArg;
      if (!targetPath) {
        targetPath = await vscode.window.showInputBox({
          prompt: 'Enter remote path',
          value: fileTreeProvider.getCurrentPath(connection.id),
          placeHolder: '/var/log or /home/user',
          ignoreFocusOut: true,
        });
      }

      if (!targetPath) return;

      // Verify path exists
      try {
        logCommand('goToPath', targetPath);
        await connection.listFiles(targetPath);
        fileTreeProvider.setCurrentPath(connection.id, targetPath);
        logResult('goToPath', true, targetPath);
      } catch (error) {
        logResult('goToPath', false, (error as Error).message);
        vscode.window.showErrorMessage(`Cannot access path: ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.goToParent', async (item?: ConnectionTreeItem | FileTreeItem) => {
      let connection: SSHConnection;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof FileTreeItem) {
        connection = item.connection;
      } else {
        const conn = await selectConnection(connectionManager);
        if (!conn) return;
        connection = conn;
      }

      const currentPath = fileTreeProvider.getCurrentPath(connection.id);
      if (currentPath === '/') {
        vscode.window.setStatusBarMessage('$(info) Already at root', 2000);
        return;
      }

      // Get parent path
      const parentPath = currentPath === '~' ? '/' : (path.posix.dirname(currentPath) || '/');
      fileTreeProvider.setCurrentPath(connection.id, parentPath);
      log(`Navigated to parent: ${parentPath}`);
      vscode.window.setStatusBarMessage(`$(arrow-up) Navigated to ${parentPath}`, 2000);
    }),

    vscode.commands.registerCommand('sshLite.goToHome', async (item?: ConnectionTreeItem | FileTreeItem) => {
      let connection: SSHConnection;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof FileTreeItem) {
        connection = item.connection;
      } else {
        const conn = await selectConnection(connectionManager);
        if (!conn) return;
        connection = conn;
      }

      fileTreeProvider.setCurrentPath(connection.id, '~');
      log('Navigated to home directory');
      vscode.window.setStatusBarMessage('$(home) Navigated to ~', 2000);
    }),

    vscode.commands.registerCommand('sshLite.goToRoot', async (item?: ConnectionTreeItem | FileTreeItem) => {
      let connection: SSHConnection;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof FileTreeItem) {
        connection = item.connection;
      } else {
        const conn = await selectConnection(connectionManager);
        if (!conn) return;
        connection = conn;
      }

      fileTreeProvider.setCurrentPath(connection.id, '/');
      log('Navigated to root directory');
      vscode.window.setStatusBarMessage('$(folder) Navigated to /', 2000);
    }),

    // File commands
    vscode.commands.registerCommand('sshLite.openFile', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        return;
      }

      logCommand('openFile', item.file.path);
      try {
        await fileService.openRemoteFile(item.connection, item.file);
        logResult('openFile', true, item.file.name);
      } catch (error) {
        logResult('openFile', false, (error as Error).message);
      }
    }),

    vscode.commands.registerCommand('sshLite.downloadFile', async (item?: FileTreeItem) => {
      if (!item) {
        return;
      }

      logCommand('downloadFile', item.file.path);
      try {
        if (item.file.isDirectory) {
          await fileService.downloadFolder(item.connection, item.file);
        } else {
          await fileService.downloadFileTo(item.connection, item.file);
        }
        logResult('downloadFile', true, item.file.name);
        fileTreeProvider.refresh();
      } catch (error) {
        logResult('downloadFile', false, (error as Error).message);
      }
    }),

    // Copy path to clipboard
    vscode.commands.registerCommand('sshLite.copyPath', async (item?: FileTreeItem) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(item.file.path);
      vscode.window.setStatusBarMessage(`$(check) Copied: ${item.file.path}`, 2000);
    }),

    // Copy host to clipboard
    vscode.commands.registerCommand('sshLite.copyHost', async (item?: ServerTreeItem | CredentialTreeItem) => {
      let hostname: string | undefined;

      if (item instanceof ServerTreeItem) {
        hostname = item.primaryHost.host;
      } else if (item instanceof CredentialTreeItem) {
        hostname = item.hostConfig.host;
      }

      if (hostname) {
        await vscode.env.clipboard.writeText(hostname);
        vscode.window.setStatusBarMessage(`$(check) Copied: ${hostname}`, 2000);
      }
    }),

    vscode.commands.registerCommand('sshLite.uploadFile', async (item?: FileTreeItem | ConnectionTreeItem) => {
      if (!item) {
        return;
      }

      let connection: typeof item.connection;
      let remotePath: string;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
        const config = vscode.workspace.getConfiguration('sshLite');
        remotePath = config.get<string>('defaultRemotePath', '~');
        // Expand ~ to actual home directory
        if (remotePath === '~') {
          try {
            const result = await connection.exec('echo $HOME');
            remotePath = result.trim();
          } catch {
            remotePath = '/home/' + connection.host.username;
          }
        }
      } else if (item instanceof FileTreeItem && item.file.isDirectory) {
        connection = item.connection;
        remotePath = item.file.path;
      } else {
        return;
      }

      logCommand('uploadFile', remotePath);
      try {
        await fileService.uploadFileTo(connection, remotePath);
        logResult('uploadFile', true, remotePath);
        fileTreeProvider.refresh();
      } catch (error) {
        logResult('uploadFile', false, (error as Error).message);
      }
    }),

    vscode.commands.registerCommand('sshLite.deleteRemote', async (item?: FileTreeItem) => {
      if (!item) {
        return;
      }

      logCommand('deleteRemote', item.file.path);
      const deleted = await fileService.deleteRemote(item.connection, item.file);
      if (deleted) {
        logResult('deleteRemote', true, item.file.name);
        fileTreeProvider.refresh();
      } else {
        logResult('deleteRemote', false, 'Cancelled or failed');
      }
    }),

    vscode.commands.registerCommand('sshLite.createFolder', async (item?: FileTreeItem | ConnectionTreeItem) => {
      if (!item) {
        return;
      }

      let connection: typeof item.connection;
      let parentPath: string;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
        const config = vscode.workspace.getConfiguration('sshLite');
        parentPath = config.get<string>('defaultRemotePath', '~');
        if (parentPath === '~') {
          try {
            const result = await connection.exec('echo $HOME');
            parentPath = result.trim();
          } catch {
            parentPath = '/home/' + connection.host.username;
          }
        }
      } else if (item instanceof FileTreeItem && item.file.isDirectory) {
        connection = item.connection;
        parentPath = item.file.path;
      } else {
        return;
      }

      logCommand('createFolder', parentPath);
      const created = await fileService.createFolder(connection, parentPath);
      if (created) {
        logResult('createFolder', true, parentPath);
        fileTreeProvider.refresh();
      } else {
        logResult('createFolder', false, 'Cancelled or failed');
      }
    }),

    vscode.commands.registerCommand('sshLite.refreshFiles', () => {
      fileTreeProvider.refresh();
    }),

    // Expand all tree nodes for a specific view
    // After expanding, toggle the button to show "Collapse All"
    vscode.commands.registerCommand('sshLite.expandAll', async (viewId?: string) => {
      await vscode.commands.executeCommand('list.expandRecursively');
      // Set context to show collapse button instead
      if (viewId) {
        await vscode.commands.executeCommand('setContext', `sshLite.${viewId}.expanded`, true);
      } else {
        // If no viewId, set all to expanded
        await vscode.commands.executeCommand('setContext', 'sshLite.hosts.expanded', true);
        await vscode.commands.executeCommand('setContext', 'sshLite.fileExplorer.expanded', true);
        await vscode.commands.executeCommand('setContext', 'sshLite.activity.expanded', true);
        await vscode.commands.executeCommand('setContext', 'sshLite.portForwards.expanded', true);
      }
    }),

    // Collapse all tree nodes for a specific view
    // After collapsing, toggle the button to show "Expand All"
    vscode.commands.registerCommand('sshLite.collapseAll', async (viewId?: string) => {
      await vscode.commands.executeCommand('list.collapseAll');
      // Set context to show expand button instead
      if (viewId) {
        await vscode.commands.executeCommand('setContext', `sshLite.${viewId}.expanded`, false);
      } else {
        // If no viewId, set all to collapsed
        await vscode.commands.executeCommand('setContext', 'sshLite.hosts.expanded', false);
        await vscode.commands.executeCommand('setContext', 'sshLite.fileExplorer.expanded', false);
        await vscode.commands.executeCommand('setContext', 'sshLite.activity.expanded', false);
        await vscode.commands.executeCommand('setContext', 'sshLite.portForwards.expanded', false);
      }
    }),

    // Filter files in tree view
    vscode.commands.registerCommand('sshLite.filterFiles', async () => {
      logCommand('filterFiles');
      const currentFilter = fileTreeProvider.getFilter();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter filter pattern (plain text or glob: *.ts, config*)',
        placeHolder: 'Plain text or *.ts, *.json, config*, etc.',
        value: currentFilter,
        title: 'Filter Files',
      });

      if (input !== undefined) {
        fileTreeProvider.setFilter(input);
        if (input) {
          logResult('filterFiles', true, `Pattern: "${input}"`);
          vscode.window.setStatusBarMessage(`$(filter) Filter: ${input}`, 3000);
        } else {
          logResult('filterFiles', true, 'Filter cleared');
          vscode.window.setStatusBarMessage('$(filter) Filter cleared', 2000);
        }
      }
    }),

    // Clear filter
    vscode.commands.registerCommand('sshLite.clearFilter', () => {
      logCommand('clearFilter');
      fileTreeProvider.clearFilter();
      logResult('clearFilter', true);
      vscode.window.setStatusBarMessage('$(filter) Filter cleared', 2000);
    }),

    // Search server for current filter (user-triggered, LITE)
    vscode.commands.registerCommand('sshLite.searchServerForFilter', async () => {
      const currentFilter = fileTreeProvider.getFilter();
      if (!currentFilter) {
        vscode.window.showWarningMessage('Set a filter first, then search the server');
        return;
      }

      const connections = connectionManager.getAllConnections();
      if (connections.length === 0) {
        vscode.window.showWarningMessage('No active SSH connections');
        return;
      }

      logCommand('searchServerForFilter', `"${currentFilter}"`);
      vscode.window.setStatusBarMessage(`$(search~spin) Searching server for "${currentFilter}"...`, 30000);
      const result = await fileTreeProvider.searchServerForFilter();
      logResult('searchServerForFilter', true, `Found ${result.count} files${result.hitLimit ? ' (limit reached)' : ''}`);

      if (result.hitLimit) {
        const action = await vscode.window.showWarningMessage(
          `Found ${result.count} files (limit ${result.limit} reached). Results may be incomplete.`,
          'Increase Limit',
          'OK'
        );
        if (action === 'Increase Limit') {
          const config = vscode.workspace.getConfiguration('sshLite');
          const newLimit = await vscode.window.showInputBox({
            prompt: `Enter new filter limit (current: ${result.limit})`,
            value: String(result.limit * 2),
            validateInput: (value) => {
              const num = parseInt(value, 10);
              if (isNaN(num) || num < 100 || num > 10000) {
                return 'Please enter a number between 100 and 10000';
              }
              return null;
            },
          });
          if (newLimit) {
            const limit = parseInt(newLimit, 10);
            await config.update('filterMaxResults', limit, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Filter limit increased to ${limit}. Re-run the filter to see more results.`);
          }
        }
      } else {
        vscode.window.setStatusBarMessage(`$(search) Found ${result.count} files`, 3000);
      }
    }),

    // Show search panel
    vscode.commands.registerCommand('sshLite.showSearch', () => {
      const searchPanel = SearchPanel.getInstance();

      // Set callback for opening files from search results
      searchPanel.setOpenFileCallback(async (connectionId: string, remotePath: string, line?: number) => {
        const connection = connectionManager.getConnection(connectionId);
        if (!connection) {
          vscode.window.showErrorMessage('Connection not found');
          return;
        }

        // Create a remote file object
        const remoteFile = {
          name: remotePath.split('/').pop() || remotePath,
          path: remotePath,
          isDirectory: false,
          size: 0,
          modifiedTime: Date.now(),
          connectionId,
        };

        // Open the file
        await fileService.openRemoteFile(connection, remoteFile);

        // If we have a line number, go to that line
        if (line) {
          setTimeout(async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              const position = new vscode.Position(line - 1, 0);
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
          }, 300);
        }
      });

      // Set connection resolver to avoid stale references after auto-reconnect
      searchPanel.setConnectionResolver((connectionId) => connectionManager.getConnection(connectionId));

      // Add all connections' current paths as default scopes only if no scopes exist
      if (!searchPanel.hasScopes()) {
        const connections = connectionManager.getAllConnections();
        for (const conn of connections) {
          searchPanel.addScope(fileTreeProvider.getCurrentPath(conn.id), conn);
        }
      }

      searchPanel.show();
      searchPanel.focusSearchInput();
    }),

    // Search in scope - add folder/file to search panel and focus
    vscode.commands.registerCommand('sshLite.searchInScope', async (item?: FileTreeItem | ConnectionTreeItem) => {
      const searchPanel = SearchPanel.getInstance();

      // Set callback for opening files
      searchPanel.setOpenFileCallback(async (connectionId: string, remotePath: string, line?: number, searchQuery?: string) => {
        const connection = connectionManager.getConnection(connectionId);
        if (!connection) {
          vscode.window.showErrorMessage('Connection not found');
          return;
        }

        // Check if file is already open in VS Code (includes hidden tabs, not just visible)
        const localPath = fileService.getLocalFilePath(connectionId, remotePath);
        const existingDocument = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === localPath
        );

        if (existingDocument) {
          // File already open - just focus and jump to line (no reload needed)
          await vscode.window.showTextDocument(existingDocument, { preview: false });
        } else {
          // File not open - download and open
          const remoteFile = {
            name: remotePath.split('/').pop() || remotePath,
            path: remotePath,
            isDirectory: false,
            size: 0,
            modifiedTime: Date.now(),
            connectionId,
          };
          await fileService.openRemoteFile(connection, remoteFile);
        }

        // Jump to line and highlight search match
        if (line) {
          setTimeout(async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              const position = new vscode.Position(line - 1, 0);
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

              // Highlight the search query if provided
              if (searchQuery) {
                const lineText = editor.document.lineAt(line - 1).text;
                const matchIndex = lineText.toLowerCase().indexOf(searchQuery.toLowerCase());
                if (matchIndex >= 0) {
                  const startPos = new vscode.Position(line - 1, matchIndex);
                  const endPos = new vscode.Position(line - 1, matchIndex + searchQuery.length);
                  editor.selection = new vscode.Selection(startPos, endPos);
                }
              }
            }
          }, 300);
        }
      });

      // Set connection resolver to avoid stale references after auto-reconnect
      searchPanel.setConnectionResolver((connectionId) => connectionManager.getConnection(connectionId));

      // Add the selected scope (don't clear existing scopes to allow multiple)
      if (item instanceof ConnectionTreeItem) {
        const searchPath = fileTreeProvider.getCurrentPath(item.connection.id);
        searchPanel.addScope(searchPath, item.connection);
      } else if (item instanceof FileTreeItem) {
        // For files, add the file directly as search scope
        // For folders, add the folder itself
        if (item.file.isDirectory) {
          searchPanel.addScope(item.file.path, item.connection, false);
        } else {
          // Add file directly - grep can search within a single file
          searchPanel.addScope(item.file.path, item.connection, true);
        }
      } else {
        // No item - add all connections' current paths (only if no scopes exist)
        if (!searchPanel.hasScopes()) {
          const connections = connectionManager.getAllConnections();
          for (const conn of connections) {
            searchPanel.addScope(fileTreeProvider.getCurrentPath(conn.id), conn);
          }
        }
      }

      searchPanel.show();
      searchPanel.focusSearchInput();
    }),

    // Cancel search - cancels all ongoing search processes
    vscode.commands.registerCommand('sshLite.cancelSearch', () => {
      const searchPanel = SearchPanel.getInstance();
      searchPanel.cancelSearch();
    }),

    // Activity commands
    vscode.commands.registerCommand('sshLite.cancelActivity', (item?: ActivityTreeItem) => {
      if (item && item.activity) {
        activityService.cancelActivity(item.activity.id);
        vscode.window.setStatusBarMessage(`$(stop) Cancelled: ${item.activity.description}`, 2000);
      }
    }),

    vscode.commands.registerCommand('sshLite.cancelAllActivities', () => {
      const runningCount = activityService.getRunningActivities().length;
      if (runningCount === 0) {
        vscode.window.setStatusBarMessage('$(check) No running activities to cancel', 2000);
        return;
      }
      activityService.cancelAll();
      vscode.window.setStatusBarMessage(`$(stop) Cancelled ${runningCount} activities`, 2000);
    }),

    vscode.commands.registerCommand('sshLite.cancelServerActivities', (item?: ServerGroupTreeItem) => {
      if (item && item.connectionId) {
        const activities = activityService.getActivitiesForConnection(item.connectionId)
          .filter(a => a.status === 'running');
        if (activities.length === 0) {
          vscode.window.setStatusBarMessage(`$(check) No running activities for ${item.serverName}`, 2000);
          return;
        }
        activityService.cancelAllForConnection(item.connectionId);
        vscode.window.setStatusBarMessage(`$(stop) Cancelled ${activities.length} activities for ${item.serverName}`, 2000);
      }
    }),

    vscode.commands.registerCommand('sshLite.clearActivities', () => {
      activityService.clearAll();
      vscode.window.setStatusBarMessage('$(clear-all) Activities cleared', 2000);
    }),

    vscode.commands.registerCommand('sshLite.toggleActivityGrouping', () => {
      const currentMode = activityTreeProvider.getGroupingMode();
      const newMode = currentMode === 'server' ? 'type' : 'server';
      activityTreeProvider.setGroupingMode(newMode);
      vscode.window.setStatusBarMessage(`$(list-tree) Grouping by ${newMode}`, 2000);
    }),

    // Filter files by name in folder (highlights in tree)
    vscode.commands.registerCommand('sshLite.filterFileNames', async (item?: FileTreeItem) => {
      if (!item || !item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a folder to filter');
        return;
      }

      const pattern = await vscode.window.showInputBox({
        prompt: `Filter files in ${item.file.name}`,
        placeHolder: '*.ts, config*, etc.',
        title: 'Filter by Filename',
      });

      if (pattern) {
        await fileTreeProvider.setFilenameFilter(pattern, item.file.path, item.connection);
        vscode.commands.executeCommand('setContext', 'sshLite.hasFilenameFilter', true);
        vscode.window.setStatusBarMessage(`$(filter) Filtering: ${pattern} in ${item.file.name}`, 0);
      }
    }),

    // Clear filename filter (can be triggered from tree view navigation bar or folder inline icon)
    vscode.commands.registerCommand('sshLite.clearFilenameFilter', (_item?: FileTreeItem) => {
      fileTreeProvider.clearFilenameFilter();
      vscode.commands.executeCommand('setContext', 'sshLite.hasFilenameFilter', false);
      vscode.window.setStatusBarMessage('$(filter) Filter cleared', 2000);
    }),

    // Reveal search result in file tree
    vscode.commands.registerCommand('sshLite.revealSearchResultInTree', async (result?: { path: string; connectionId: string }) => {
      if (!result || !result.path || !result.connectionId) {
        vscode.window.showWarningMessage('No search result selected');
        return;
      }

      const connection = connectionManager.getConnection(result.connectionId);
      if (!connection) {
        vscode.window.showErrorMessage('Connection not found');
        return;
      }

      // Navigate to parent folder and reveal the file
      const treeItem = await fileTreeProvider.revealFile(result.connectionId, result.path);
      if (treeItem) {
        // Reveal in tree view with focus
        await fileTreeView.reveal(treeItem, { select: true, focus: true, expand: true });
        vscode.window.setStatusBarMessage(`$(target) Revealed ${treeItem.file.name} in tree`, 3000);
      } else {
        vscode.window.showWarningMessage('Could not reveal file in tree');
      }
    }),

    // Cancel preloading operations
    vscode.commands.registerCommand('sshLite.cancelPreloading', () => {
      const dirStatus = fileTreeProvider.getPreloadStatus();
      const fileStatus = fileService.getPreloadStatus();

      if (dirStatus.active > 0 || dirStatus.queued > 0 || fileStatus.active > 0) {
        fileTreeProvider.cancelPreloading();
        fileService.cancelPreloading();
        preloadStatusBar.hide();
        vscode.window.setStatusBarMessage('$(x) Preloading cancelled', 3000);
      } else {
        vscode.window.setStatusBarMessage('$(info) No preloading in progress', 2000);
      }
    }),

    // Reveal current file in tree
    vscode.commands.registerCommand('sshLite.revealInTree', async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showInformationMessage('No file is currently open');
        return;
      }

      const localPath = normalizeLocalPath(activeEditor.document.uri.fsPath);
      log(`revealInTree: localPath=${localPath}`);

      // Try to get mapping from FileService
      let mapping = fileService.getMappingForLocalPath(localPath);

      // If not found, try to extract from temp path structure
      // Temp files are stored as: tempDir/connectionId/remote/path/to/file.txt
      if (!mapping) {
        const tempDir = fileService.getTempDir();
        if (localPath.startsWith(tempDir)) {
          const relativePath = localPath.substring(tempDir.length);
          // Split by path separator and get connectionId (first segment after tempDir)
          const segments = relativePath.split(/[/\\]/).filter(s => s.length > 0);
          if (segments.length >= 2) {
            const connectionId = segments[0];
            const remotePath = '/' + segments.slice(1).join('/');
            log(`revealInTree: Extracted from path - connectionId=${connectionId}, remotePath=${remotePath}`);

            // Verify connection exists
            const connection = connectionManager.getConnection(connectionId);
            if (connection) {
              mapping = { connectionId, remotePath };
            }
          }
        }
      }

      if (!mapping) {
        log(`revealInTree: No mapping found for ${localPath}`);
        vscode.window.showInformationMessage('Current file is not a remote SSH file');
        return;
      }

      log(`revealInTree: Found mapping - connectionId=${mapping.connectionId}, remotePath=${mapping.remotePath}`);

      // Navigate to parent folder and reveal the file
      const treeItem = await fileTreeProvider.revealFile(mapping.connectionId, mapping.remotePath);
      if (treeItem) {
        // Reveal in tree view with focus
        await fileTreeView.reveal(treeItem, { select: true, focus: true, expand: true });
        vscode.window.setStatusBarMessage(`$(target) Revealed ${treeItem.file.name} in tree`, 3000);
      }
    }),

    // Refresh individual file or folder
    vscode.commands.registerCommand('sshLite.refreshItem', async (item?: FileTreeItem) => {
      if (!item) {
        return;
      }

      if (item.file.isDirectory) {
        // For folders, refresh just that folder's contents in the tree
        fileTreeProvider.refreshFolder(item.connection.id, item.file.path);
      } else {
        // For files, re-download and refresh if the file is currently open
        await fileService.refreshOpenFile(item.connection, item.file.path);
      }
    }),

    // Open terminal at specific path (for files/folders in file tree)
    vscode.commands.registerCommand('sshLite.openTerminalHere', async (item?: FileTreeItem | ConnectionTreeItem) => {
      if (!item) {
        return;
      }

      let connection: SSHConnection;
      let targetPath: string;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
        targetPath = fileTreeProvider.getCurrentPath(connection.id);
      } else if (item instanceof FileTreeItem) {
        connection = item.connection;
        // If it's a file, cd to its parent directory
        targetPath = item.file.isDirectory ? item.file.path : path.posix.dirname(item.file.path);
      } else {
        return;
      }

      logCommand('openTerminalHere', targetPath);
      const terminal = await terminalService.createTerminal(connection);
      if (terminal) {
        terminal.sendText(`cd "${targetPath}"`);
        logResult('openTerminalHere', true, `cd "${targetPath}"`);
      }
    }),

    // Terminal commands
    vscode.commands.registerCommand('sshLite.openTerminal', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        // From file explorer
        connection = item.connection;
      } else if (item instanceof ServerTreeItem) {
        // From server tree - find first connected user
        for (const host of item.hosts) {
          connection = connectionManager.getConnection(host.id);
          if (connection) break;
        }
      }

      if (!connection) {
        // If no item provided, show quick pick for connected hosts
        const connections = connectionManager.getAllConnections();
        if (connections.length === 0) {
          vscode.window.showWarningMessage('No active SSH connections');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          connections.map((c) => ({
            label: c.host.name,
            description: `${c.host.username}@${c.host.host}`,
            connection: c,
          })),
          {
            placeHolder: 'Select connection for terminal',
            ignoreFocusOut: true,
          }
        );

        if (!selected) {
          return;
        }

        connection = selected.connection;
      }

      logCommand('openTerminal', connection.host.name);
      await terminalService.createTerminal(connection);
      logResult('openTerminal', true, connection.host.name);
    }),

    // Port forward commands
    vscode.commands.registerCommand('sshLite.forwardPort', async () => {
      logCommand('forwardPort');
      await portForwardService.promptForwardPort();
    }),

    vscode.commands.registerCommand('sshLite.stopForward', async (item?: PortForwardTreeItem) => {
      if (!item) {
        return;
      }

      logCommand('stopForward', `${item.forward.localPort} -> ${item.forward.remoteHost}:${item.forward.remotePort}`);
      await portForwardService.stopForward(item.forward);
      logResult('stopForward', true);
    }),

    // Audit log commands
    vscode.commands.registerCommand('sshLite.showAuditLog', () => {
      auditService.showLog();
    }),

    vscode.commands.registerCommand('sshLite.exportAuditLog', async () => {
      try {
        const exportPath = await auditService.exportLogs();
        vscode.window.showInformationMessage(`Audit log exported to ${exportPath}`);
      } catch (error) {
        if ((error as Error).message !== 'No export path selected') {
          vscode.window.showErrorMessage(`Failed to export audit log: ${(error as Error).message}`);
        }
      }
    }),

    vscode.commands.registerCommand('sshLite.clearAuditLog', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all audit logs?',
        { modal: true },
        'Clear'
      );

      if (confirm === 'Clear') {
        auditService.clearLogs();
        vscode.window.setStatusBarMessage('$(check) Audit log cleared', 3000);
      }
    }),

    // Monitor commands
    vscode.commands.registerCommand('sshLite.monitor', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;
      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof ServerTreeItem) {
        // Find first connected user for this server
        for (const host of item.hosts) {
          connection = connectionManager.getConnection(host.id);
          if (connection) break;
        }
      }
      if (!connection) {
        connection = await selectConnection(connectionManager);
      }

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await showMonitorQuickPick(connection);
    }),

    vscode.commands.registerCommand('sshLite.quickStatus', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;
      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof ServerTreeItem) {
        for (const host of item.hosts) {
          connection = connectionManager.getConnection(host.id);
          if (connection) break;
        }
      }
      if (!connection) {
        connection = await selectConnection(connectionManager);
      }

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await monitorService.quickStatus(connection);
    }),

    vscode.commands.registerCommand('sshLite.diagnoseSlowness', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;
      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof ServerTreeItem) {
        for (const host of item.hosts) {
          connection = connectionManager.getConnection(host.id);
          if (connection) break;
        }
      }
      if (!connection) {
        connection = await selectConnection(connectionManager);
      }

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await monitorService.diagnoseSlowness(connection);
    }),

    // Clear all credentials for a server
    vscode.commands.registerCommand('sshLite.clearCredentials', async (item?: ServerTreeItem) => {
      if (!item) {
        vscode.window.showWarningMessage('Select a server first');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Clear all saved passwords for ${item.primaryHost.name}?`,
        'Clear All'
      );

      if (confirm === 'Clear All') {
        // Clear credentials for all users on this server
        for (const host of item.hosts) {
          await credentialService.deleteAll(host.id);
        }
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage('$(check) All passwords cleared', 3000);
      }
    }),

    // Add credential/user command - handles ServerTreeItem from new tree structure
    vscode.commands.registerCommand('sshLite.addCredential', async (serverItem?: ServerTreeItem) => {
      log(`addCredential: called with serverItem=${serverItem ? serverItem.serverKey : 'undefined'}`);
      if (!serverItem) {
        vscode.window.showWarningMessage('Select a server first');
        return;
      }

      // Get server info from the first host
      const templateHost = serverItem.primaryHost;
      const [host, portStr] = serverItem.serverKey.split(':');
      const port = parseInt(portStr, 10);

      // Ask for username
      const username = await vscode.window.showInputBox({
        prompt: `Enter username for ${host}`,
        placeHolder: 'e.g., root, admin, ubuntu',
        ignoreFocusOut: true,
      });

      if (!username) return;

      // Check if this username already exists for this server
      const existingHost = serverItem.hosts.find(h => h.username === username);
      if (existingHost) {
        vscode.window.showWarningMessage(`User "${username}" already exists for this server`);
        return;
      }

      // Ask for password
      const password = await vscode.window.showInputBox({
        prompt: `Enter password for ${username}@${host}`,
        password: true,
        ignoreFocusOut: true,
      });

      if (!password) return;

      // Create a new saved host with this username
      const newHostId = `${host}:${port}:${username}`;
      const newHost: IHostConfig = {
        id: newHostId,
        name: templateHost.name, // Use same display name as the server
        host: host,
        port: port,
        username: username,
        source: 'saved',
      };

      log(`addCredential: Adding new user "${username}" for server ${serverItem.serverKey}`);
      try {
        // Save the host
        hostService.saveHost(newHost);

        // Save the credential (password)
        const cred = await credentialService.addCredential(newHostId, 'Default', 'password', password);
        log(`addCredential: Success - created host ${newHostId} with credential ${cred.id}`);

        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) User "${username}" added`, 3000);
      } catch (error) {
        log(`addCredential: Error - ${(error as Error).message}`);
        vscode.window.showErrorMessage(`Failed to add user: ${(error as Error).message}`);
      }
    }),

    // Save password for existing user credential
    vscode.commands.registerCommand('sshLite.savePassword', async (item?: UserCredentialTreeItem) => {
      if (!item) {
        vscode.window.showWarningMessage('Select a user first');
        return;
      }

      const hostConfig = item.hostConfig;

      // Ask for password
      const password = await vscode.window.showInputBox({
        prompt: `Enter password for ${hostConfig.username}@${hostConfig.host}`,
        password: true,
        ignoreFocusOut: true,
      });

      if (!password) return;

      log(`savePassword: Saving password for ${hostConfig.username}@${hostConfig.host}`);
      try {
        if (item.credential) {
          // Update existing credential
          await credentialService.updateCredentialPassword(hostConfig.id, item.credential.id, password);
        } else {
          // Create new credential
          await credentialService.addCredential(hostConfig.id, 'Default', 'password', password);
        }
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) Password saved for ${hostConfig.username}`, 3000);
      } catch (error) {
        log(`savePassword: Error - ${(error as Error).message}`);
        vscode.window.showErrorMessage(`Failed to save password: ${(error as Error).message}`);
      }
    }),

    // Connect with specific credential
    vscode.commands.registerCommand('sshLite.connectWithCredential', async (hostConfig?: IHostConfig, credential?: SavedCredential | null) => {
      if (!hostConfig) {
        vscode.window.showWarningMessage('Invalid host selection');
        return;
      }

      // If no credential, prompt for password first
      let effectiveCredential = credential;
      if (!effectiveCredential) {
        const password = await vscode.window.showInputBox({
          prompt: `Enter password for ${hostConfig.username}@${hostConfig.host}`,
          password: true,
          ignoreFocusOut: true,
        });

        if (!password) return;

        // Save the credential for next time
        try {
          effectiveCredential = await credentialService.addCredential(hostConfig.id, 'Default', 'password', password);
          hostTreeProvider.refresh();
        } catch (error) {
          log(`Failed to save credential: ${(error as Error).message}`);
          // Continue anyway with a temporary credential object
          effectiveCredential = {
            id: 'temp',
            label: 'Temporary',
            type: 'password',
          };
          // Store in session only
          credentialService.setSessionCredential(hostConfig.id, 'temp', password);
        }
      }

      try {
        log(`Connecting to ${hostConfig.name} with credential "${effectiveCredential.label}"...`);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connectWithCredential(hostConfig!, effectiveCredential!);
          }
        );

        log(`Connected to ${hostConfig.name}`);
        // Auto-dismiss connection success (non-blocking UX)
        vscode.window.setStatusBarMessage(`$(check) Connected to ${hostConfig.name}`, 3000);
      } catch (error) {
        log(`Connection failed: ${(error as Error).message}`);
        const errMsg = (error as Error).message;
        const isAuthError = errMsg.includes('authentication') || errMsg.includes('password') || errMsg.includes('Permission denied') || errMsg.includes('All configured authentication methods failed');

        if (isAuthError && effectiveCredential.type === 'password') {
          // Authentication failed - offer to retry with new password
          const action = await vscode.window.showErrorMessage(
            `Connection failed: ${errMsg}`,
            'Enter New Password',
            'Cancel'
          );

          if (action === 'Enter New Password') {
            // Prompt for new password
            const newPassword = await vscode.window.showInputBox({
              prompt: `Enter password for ${hostConfig.username}@${hostConfig.host}`,
              password: true,
              ignoreFocusOut: true,
            });

            if (newPassword) {
              try {
                // Update the credential with new password
                await credentialService.updateCredentialPassword(hostConfig.id, effectiveCredential.id, newPassword);
                log(`Updated password for credential "${effectiveCredential.label}"`);

                // Retry connection with updated credential
                const updatedCredential = { ...effectiveCredential };
                await vscode.window.withProgress(
                  {
                    location: vscode.ProgressLocation.Notification,
                    title: `Reconnecting to ${hostConfig.name}...`,
                    cancellable: false,
                  },
                  async () => {
                    await connectionManager.connectWithCredential(hostConfig!, updatedCredential);
                  }
                );

                log(`Connected to ${hostConfig.name}`);
                vscode.window.setStatusBarMessage(`$(check) Connected to ${hostConfig.name}`, 3000);
                hostTreeProvider.refresh();
              } catch (retryError) {
                log(`Retry connection failed: ${(retryError as Error).message}`);
                vscode.window.showErrorMessage(`Connection failed: ${(retryError as Error).message}. Verify your password.`);
              }
            }
          }
        } else {
          // Non-auth error or non-password credential
          let suggestion = '';
          if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT')) {
            suggestion = ' Check if the server is running and the port is correct.';
          } else if (isAuthError) {
            suggestion = ' Verify your username and password/key.';
          } else if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
            suggestion = ' Check the hostname - it may be misspelled or unreachable.';
          }
          vscode.window.showErrorMessage(`Connection failed: ${errMsg}${suggestion}`);
        }
      }
    }),

    // Delete credential command (removes saved password for a user)
    vscode.commands.registerCommand('sshLite.deleteCredential', async (item?: UserCredentialTreeItem) => {
      if (!item) {
        log('deleteCredential: No item provided');
        vscode.window.showWarningMessage('Select a user to delete password');
        return;
      }

      if (!item.credential) {
        vscode.window.showInformationMessage('No saved password to delete');
        return;
      }

      log(`deleteCredential: Deleting credential for user "${item.hostConfig.username}" (hostId: ${item.hostConfig.id})`);

      const confirm = await vscode.window.showWarningMessage(
        `Delete saved password for "${item.hostConfig.username}"?`,
        'Delete'
      );

      if (confirm === 'Delete') {
        try {
          await credentialService.deleteCredential(item.hostConfig.id, item.credential.id);
          hostTreeProvider.refresh();
          vscode.window.setStatusBarMessage('$(check) Password deleted', 3000);
          log('deleteCredential: Success');
        } catch (error) {
          log(`deleteCredential: Error - ${(error as Error).message}`);
          vscode.window.showErrorMessage(`Failed to delete password: ${(error as Error).message}`);
        }
      }
    }),

    // Clear all temp files command
    vscode.commands.registerCommand('sshLite.clearAllTempFiles', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all temporary files for all servers?',
        { modal: true },
        'Clear All'
      );

      if (confirm === 'Clear All') {
        const count = fileService.clearAllTempFiles();
        vscode.window.setStatusBarMessage(`$(check) Cleared ${count} temporary file(s)`, 3000);
      }
    }),

    // Open temp files folder
    vscode.commands.registerCommand('sshLite.openTempFolder', async () => {
      const tempDir = fileService.getTempDir();
      const uri = vscode.Uri.file(tempDir);
      await vscode.env.openExternal(uri);
    }),

    // Clear cache (factory reset except credentials)
    vscode.commands.registerCommand('sshLite.clearCache', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all cache data? This will reset:\n- Directory cache\n- Folder history\n- Temp files\n- Backup history\n\nCredentials will NOT be affected.',
        { modal: true },
        'Clear Cache'
      );

      if (confirm === 'Clear Cache') {
        // Clear directory cache
        fileTreeProvider.clearCache();

        // Clear folder history
        await folderHistoryService.clearAllHistory();

        // Clear all temp files and backup history
        const tempCount = fileService.clearAllTempFiles();
        fileService.clearBackupHistory();

        // Refresh tree views
        fileTreeProvider.refresh();
        hostTreeProvider.refresh();

        vscode.window.setStatusBarMessage(
          `$(check) Cache cleared: ${tempCount} temp file(s) removed`, 5000
        );
      }
    }),

    // Pin folder to credential (from file tree context menu)
    vscode.commands.registerCommand('sshLite.pinFolder', async (item?: FileTreeItem) => {
      if (!item || !item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a folder to pin');
        return;
      }

      const connection = item.connection;
      const remotePath = item.file.path;

      // Use host config ID
      const hostId = connection.host.id;

      // Use the credential from the connection (no need to ask user - connection already knows)
      const connectionCredential = connection.credential;
      if (!connectionCredential) {
        vscode.window.showWarningMessage('No credential associated with this connection');
        return;
      }

      // Ask for a name for this pinned folder using createInputBox for button support
      const name = await new Promise<string | undefined>((resolve) => {
        const inputBox = vscode.window.createInputBox();
        inputBox.prompt = 'Name for pinned folder';
        inputBox.value = item.file.name;
        inputBox.placeholder = 'e.g., Logs, Config, Projects';
        inputBox.ignoreFocusOut = true;

        // Add Save button (checkmark icon)
        const saveButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon('check'),
          tooltip: 'Save',
        };
        inputBox.buttons = [saveButton];

        inputBox.onDidAccept(() => {
          resolve(inputBox.value);
          inputBox.dispose();
        });

        inputBox.onDidTriggerButton((button) => {
          if (button === saveButton) {
            resolve(inputBox.value);
            inputBox.dispose();
          }
        });

        inputBox.onDidHide(() => {
          resolve(undefined);
          inputBox.dispose();
        });

        inputBox.show();
      });

      if (!name) return;

      await credentialService.addPinnedFolder(
        hostId,
        connectionCredential.id,
        name,
        remotePath
      );

      hostTreeProvider.refresh();
      vscode.window.setStatusBarMessage(`$(check) Pinned "${name}" to ${connectionCredential.label}`, 3000);
    }),

    // Connect to pinned folder
    vscode.commands.registerCommand('sshLite.connectToPinnedFolder', async (
      hostConfig?: IHostConfig,
      credential?: SavedCredential,
      pinnedFolder?: PinnedFolder
    ) => {
      if (!hostConfig || !credential || !pinnedFolder) {
        vscode.window.showWarningMessage('Invalid pinned folder selection');
        return;
      }

      try {
        log(`Connecting to ${hostConfig.name} and navigating to ${pinnedFolder.remotePath}...`);
        let connection: SSHConnection | undefined;
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            connection = await connectionManager.connectWithCredential(hostConfig!, credential!);
          }
        );

        // Navigate to the pinned folder using the returned connection
        if (connection) {
          fileTreeProvider.setCurrentPath(connection.id, pinnedFolder.remotePath);
        }

        log(`Connected to ${hostConfig.name} at ${pinnedFolder.remotePath}`);
        vscode.window.setStatusBarMessage(`$(check) Connected to ${hostConfig.name}`, 3000);
      } catch (error) {
        log(`Connection failed: ${(error as Error).message}`);
        const errMsg = (error as Error).message;
        let suggestion = '';
        if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT')) {
          suggestion = ' Check if the server is running and the port is correct.';
        } else if (errMsg.includes('authentication') || errMsg.includes('password') || errMsg.includes('Permission denied')) {
          suggestion = ' Verify your username and password/key.';
        } else if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
          suggestion = ' Check the hostname - it may be misspelled or unreachable.';
        }
        vscode.window.showErrorMessage(`Connection failed: ${errMsg}${suggestion}`);
      }
    }),

    // Delete pinned folder
    vscode.commands.registerCommand('sshLite.deletePinnedFolder', async (item?: PinnedFolderTreeItem) => {
      if (!item) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove pinned folder "${item.pinnedFolder.name}"?`,
        'Remove'
      );

      if (confirm === 'Remove') {
        await credentialService.deletePinnedFolder(
          item.hostConfig.id,
          item.credential.id,
          item.pinnedFolder.id
        );
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage('$(check) Pinned folder removed', 3000);
      }
    }),

    // Rename pinned folder
    vscode.commands.registerCommand('sshLite.renamePinnedFolder', async (item?: PinnedFolderTreeItem) => {
      if (!item) {
        return;
      }

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name for this pinned folder',
        value: item.pinnedFolder.name,
        ignoreFocusOut: true,
      });

      if (!newName || newName === item.pinnedFolder.name) return;

      await credentialService.renamePinnedFolder(
        item.hostConfig.id,
        item.credential.id,
        item.pinnedFolder.id,
        newName
      );
      hostTreeProvider.refresh();
      vscode.window.setStatusBarMessage(`$(check) Renamed to "${newName}"`, 3000);
    }),

    // Clear temp files for specific server
    vscode.commands.registerCommand('sshLite.clearTempFilesForConnection', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        // From file explorer
        connection = item.connection;
      } else if (item instanceof ServerTreeItem) {
        // From server tree - find first connected user
        for (const host of item.hosts) {
          connection = connectionManager.getConnection(host.id);
          if (connection) break;
        }
      }

      if (!connection) {
        // Show quick pick for connected hosts
        const connections = connectionManager.getAllConnections();
        if (connections.length === 0) {
          vscode.window.showWarningMessage('No active connections');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          connections.map((c) => ({
            label: c.host.name,
            description: `${c.host.username}@${c.host.host}`,
            connection: c,
          })),
          {
            placeHolder: 'Select server to clear temp files',
            ignoreFocusOut: true,
          }
        );

        if (!selected) return;

        const count = fileService.clearTempFilesForConnection(selected.connection.id);
        vscode.window.setStatusBarMessage(`$(check) Cleared ${count} temp file(s) for ${selected.connection.host.name}`, 3000);
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Clear all temporary files for ${connection.host.name}?`,
        'Clear'
      );

      if (confirm === 'Clear') {
        const count = fileService.clearTempFilesForConnection(connection.id);
        vscode.window.setStatusBarMessage(`$(check) Cleared ${count} temporary file(s)`, 3000);
      }
    }),

    // Revert file to previous version
    vscode.commands.registerCommand('sshLite.revertFile', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to revert');
        return;
      }

      await fileService.showRevertPicker(item.connection, item.file.path);
    }),

    // Show file backup history
    vscode.commands.registerCommand('sshLite.showFileBackups', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to view backups');
        return;
      }

      const backups = fileService.getBackupHistory(item.connection.id, item.file.path);

      if (backups.length === 0) {
        vscode.window.showInformationMessage(`No backups available for ${item.file.name}. Backups are created when you edit and save files.`);
        return;
      }

      await fileService.showRevertPicker(item.connection, item.file.path);
    }),

    // Show server-side backup history
    vscode.commands.registerCommand('sshLite.showServerBackups', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to view server backups');
        return;
      }

      await fileService.showServerBackupPicker(item.connection, item.file.path);
    }),

    // Show changes (diff between server backup and current file)
    vscode.commands.registerCommand('sshLite.showChanges', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to view changes');
        return;
      }

      await fileService.showChanges(item.connection, item.file.path);
    }),

    // Show combined backup logs (local + server)
    vscode.commands.registerCommand('sshLite.showBackupLogs', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to view backup logs');
        return;
      }

      await fileService.showBackupLogs(item.connection, item.file.path);
    }),

    // Show all backups UI for a connection
    vscode.commands.registerCommand('sshLite.showAllBackups', async (connection?: SSHConnection | ServerTreeItem | ConnectionTreeItem) => {
      let conn: SSHConnection | undefined;

      if (connection instanceof SSHConnection) {
        conn = connection;
      } else if (connection instanceof ConnectionTreeItem) {
        conn = connection.connection;
      } else if (connection instanceof ServerTreeItem) {
        // Find first connected user for this server
        for (const host of connection.hosts) {
          conn = connectionManager.getConnection(host.id);
          if (conn) break;
        }
      } else {
        conn = await selectConnection(connectionManager);
      }

      if (!conn) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await fileService.showAllBackups(conn);
    }),

    // Open server backup folder
    vscode.commands.registerCommand('sshLite.openServerBackupFolder', async (item?: ServerTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item instanceof ServerTreeItem) {
        // Find first connected user for this server
        for (const host of item.hosts) {
          connection = connectionManager.getConnection(host.id);
          if (connection) break;
        }
      } else {
        connection = await selectConnection(connectionManager);
      }

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await fileService.openServerBackupFolder(connection);
    }),

    // Clear server backups for a connection
    vscode.commands.registerCommand('sshLite.clearServerBackups', async () => {
      const connections = connectionManager.getAllConnections();
      if (connections.length === 0) {
        vscode.window.showWarningMessage('No active connections');
        return;
      }

      let connection: SSHConnection | undefined;

      if (connections.length === 1) {
        connection = connections[0];
      } else {
        const selected = await vscode.window.showQuickPick(
          connections.map((c) => ({
            label: c.host.name,
            description: `${c.host.username}@${c.host.host}`,
            connection: c,
          })),
          { placeHolder: 'Select server to clear backups' }
        );
        connection = selected?.connection;
      }

      if (!connection) return;

      const confirm = await vscode.window.showWarningMessage(
        `Clear all server backups on ${connection.host.name}?`,
        { modal: true },
        'Clear'
      );

      if (confirm === 'Clear') {
        const count = await fileService.clearServerBackups(connection);
        vscode.window.setStatusBarMessage(`$(check) Cleared ${count} server backup(s)`, 3000);
      }
    }),
  ];

  // Register all disposables
  context.subscriptions.push(
    outputChannel,
    hostTreeView,
    fileTreeView,
    portForwardTreeView,
    activityTreeView,
    hostTreeProvider,
    fileTreeProvider,
    portForwardTreeProvider,
    activityTreeProvider,
    ...commands
  );

  // Set initial context
  vscode.commands.executeCommand('setContext', 'sshLite.hasConnections', false);

  // Cancel downloads when document/tab is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      // Check if there's an active download for this document and cancel it
      const cancelled = progressiveDownloadManager.cancelDownloadByUri(document.uri);
      if (cancelled) {
        logResult('cancelDownload', true, `Tab closed: ${document.uri.fsPath || document.uri.toString()}`);
      }
    })
  );

  // Auto-reconnect if there are open remote files from previous session
  // Check periodically until connected or timeout (2 minutes)
  let autoReconnectRunning = false;
  let autoReconnectStopped = false;

  const stopAutoReconnect = () => {
    autoReconnectStopped = true;
    clearInterval(autoReconnectInterval);
  };

  const autoReconnectInterval = setInterval(async () => {
    // Guard against concurrent execution and already stopped
    if (autoReconnectRunning || autoReconnectStopped) {
      return;
    }

    autoReconnectRunning = true;
    try {
      await autoReconnectFromOpenFiles(
        fileService,
        connectionManager,
        hostService,
        credentialService,
        hostTreeProvider,
        fileTreeProvider,
        stopAutoReconnect // Stop checking once prompted
      );
    } finally {
      autoReconnectRunning = false;
    }
  }, 2000);

  // Stop auto-reconnect checks after 2 minutes
  setTimeout(stopAutoReconnect, 120000);

  // Also clear interval when extension deactivates
  context.subscriptions.push({
    dispose: stopAutoReconnect,
  });

  log('SSH Lite extension activated');
}

/**
 * Auto-reconnect to servers if there are open remote files from previous session
 */
async function autoReconnectFromOpenFiles(
  fileService: FileService,
  connectionManager: ConnectionManager,
  hostService: HostService,
  credentialService: CredentialService,
  hostTreeProvider: HostTreeProvider,
  fileTreeProvider: FileTreeProvider,
  onPrompted?: () => void
): Promise<void> {
  const tempDir = fileService.getTempDir();

  // Find all open text documents that are remote files (in temp directory)
  // Check both workspace.textDocuments and visible editors for better coverage
  const remoteDocuments = vscode.workspace.textDocuments.filter((doc) => {
    const fp = normalizeLocalPath(doc.uri.fsPath);
    return doc.uri.scheme === 'file' && fp.startsWith(tempDir);
  });

  // Also check tab groups for restored tabs that might not be in textDocuments yet
  const tabPaths = new Set<string>();
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const fp = normalizeLocalPath(tab.input.uri.fsPath);
        if (tab.input.uri.scheme === 'file' && fp.startsWith(tempDir)) {
          tabPaths.add(fp);
        }
      }
    }
  }

  // Combine both sources
  const allRemotePaths = new Set<string>();
  for (const doc of remoteDocuments) {
    allRemotePaths.add(normalizeLocalPath(doc.uri.fsPath));
  }
  for (const path of tabPaths) {
    allRemotePaths.add(path);
  }

  if (allRemotePaths.size === 0) {
    return;
  }

  // Extract unique connection IDs from open remote files
  const connectionIdsToReconnect = new Set<string>();
  for (const filePath of allRemotePaths) {
    const relativePath = filePath.substring(tempDir.length);
    const segments = relativePath.split(/[/\\]/).filter((s) => s.length > 0);
    if (segments.length >= 2) {
      const connectionId = segments[0];
      // Only add if not already connected
      if (!connectionManager.getConnection(connectionId)) {
        connectionIdsToReconnect.add(connectionId);
      }
    }
  }

  if (connectionIdsToReconnect.size === 0) {
    return;
  }

  // Find hosts for these connection IDs
  const hostsToReconnect: IHostConfig[] = [];
  const allHosts = hostService.getAllHosts();
  for (const connectionId of connectionIdsToReconnect) {
    const host = allHosts.find((h) => h.id === connectionId);
    if (host) {
      hostsToReconnect.push(host);
    }
  }

  if (hostsToReconnect.length === 0) {
    return;
  }

  // Stop interval checks once we're about to prompt
  onPrompted?.();

  // Prompt user to reconnect
  const hostNames = hostsToReconnect.map((h) => h.name).join(', ');
  const message = hostsToReconnect.length === 1
    ? `Remote files from "${hostNames}" are open. Reconnect?`
    : `Remote files from ${hostsToReconnect.length} servers are open (${hostNames}). Reconnect?`;

  const action = await vscode.window.showInformationMessage(
    message,
    'Reconnect',
    'Reconnect All',
    'Dismiss'
  );

  if (action === 'Dismiss' || !action) {
    return;
  }

  // Reconnect to servers
  const hostsToConnect = action === 'Reconnect All' ? hostsToReconnect : [hostsToReconnect[0]];

  for (const hostConfig of hostsToConnect) {
    try {
      // Try to find a saved credential for automatic reconnection
      const credentials = credentialService.listCredentials(hostConfig.id);

      if (credentials.length === 1) {
        // Auto-connect with single credential
        log(`Auto-reconnecting to ${hostConfig.name} with saved credential...`);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Reconnecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connectWithCredential(hostConfig, credentials[0]);
          }
        );
        vscode.window.setStatusBarMessage(`$(check) Reconnected to ${hostConfig.name}`, 3000);
      } else if (credentials.length > 1) {
        // Multiple credentials - let user choose
        const selected = await vscode.window.showQuickPick(
          credentials.map((c) => ({
            label: c.label,
            description: c.type === 'password' ? 'Password' : 'Private Key',
            credential: c,
          })),
          {
            placeHolder: `Select credential for ${hostConfig.name}`,
            ignoreFocusOut: true,
          }
        );

        if (selected) {
          log(`Reconnecting to ${hostConfig.name} with credential "${selected.credential.label}"...`);
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Reconnecting to ${hostConfig.name}...`,
              cancellable: false,
            },
            async () => {
              await connectionManager.connectWithCredential(hostConfig, selected.credential);
            }
          );
          vscode.window.setStatusBarMessage(`$(check) Reconnected to ${hostConfig.name}`, 3000);
        }
      } else {
        // No saved credentials - use standard connect flow
        log(`Reconnecting to ${hostConfig.name}...`);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Reconnecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connect(hostConfig);
          }
        );
        vscode.window.setStatusBarMessage(`$(check) Reconnected to ${hostConfig.name}`, 3000);
      }
    } catch (error) {
      log(`Auto-reconnect to ${hostConfig.name} failed: ${(error as Error).message}`);
      vscode.window.showErrorMessage(`Failed to reconnect to ${hostConfig.name}: ${(error as Error).message}`);
    }
  }

  // Refresh tree views after reconnection
  hostTreeProvider.refresh();
  fileTreeProvider.refresh();
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  log('SSH Lite extension deactivating...');

  // Clean up services
  const connectionManager = ConnectionManager.getInstance();
  const fileService = FileService.getInstance();
  const terminalService = TerminalService.getInstance();
  const credentialService = CredentialService.getInstance();
  const auditService = AuditService.getInstance();
  const monitorService = ServerMonitorService.getInstance();
  const folderHistory = FolderHistoryService.getInstance();

  fileService.dispose();
  terminalService.dispose();
  credentialService.dispose();
  auditService.dispose();
  monitorService.dispose();
  folderHistory.dispose();
  connectionManager.dispose();

  log('SSH Lite extension deactivated');
}

/**
 * Log message to output channel
 */
function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

/**
 * Log command execution with result
 */
function logCommand(command: string, details?: string): void {
  const msg = details ? `[CMD] ${command}: ${details}` : `[CMD] ${command}`;
  log(msg);
}

/**
 * Log command result (success or error)
 */
function logResult(command: string, success: boolean, details?: string): void {
  const status = success ? '✓' : '✗';
  const msg = details ? `[${status}] ${command}: ${details}` : `[${status}] ${command}`;
  log(msg);
}
