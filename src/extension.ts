import * as vscode from 'vscode';
import { ConnectionManager } from './connection/ConnectionManager';
import { SSHConnection } from './connection/SSHConnection';
import { HostService } from './services/HostService';
import { FileService } from './services/FileService';
import { TerminalService } from './services/TerminalService';
import { PortForwardService } from './services/PortForwardService';
import { CredentialService } from './services/CredentialService';
import { AuditService } from './services/AuditService';
import { ServerMonitorService, showMonitorQuickPick } from './services/ServerMonitorService';
import { FolderHistoryService } from './services/FolderHistoryService';
import { ProgressiveDownloadManager } from './services/ProgressiveDownloadManager';
import { HostTreeProvider, HostTreeItem, CredentialTreeItem, PinnedFolderTreeItem, setExtensionPath } from './providers/HostTreeProvider';
import { SavedCredential, PinnedFolder } from './services/CredentialService';
import { IHostConfig, ConnectionState } from './types';
import { FileTreeProvider, FileTreeItem, ConnectionTreeItem, setFileTreeExtensionPath } from './providers/FileTreeProvider';
import { PortForwardTreeProvider, PortForwardTreeItem } from './providers/PortForwardTreeProvider';
import { SearchResultsProvider, SearchResult, SearchResultFileItem, SearchResultMatchItem } from './providers/SearchResultsProvider';
import { SearchPanel } from './webviews/SearchPanel';
import { ProgressiveFileContentProvider } from './providers/ProgressiveFileContentProvider';
import { PROGRESSIVE_PREVIEW_SCHEME } from './types/progressive';

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
  const searchResultsProvider = new SearchResultsProvider();

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

  // Register tree views
  const hostTreeView = vscode.window.createTreeView('sshLite.hosts', {
    treeDataProvider: hostTreeProvider,
    showCollapseAll: false,
  });

  const fileTreeView = vscode.window.createTreeView('sshLite.fileExplorer', {
    treeDataProvider: fileTreeProvider,
    showCollapseAll: true,
    dragAndDropController: fileTreeProvider,
    canSelectMany: true,
  });

  const portForwardTreeView = vscode.window.createTreeView('sshLite.portForwards', {
    treeDataProvider: portForwardTreeProvider,
    showCollapseAll: false,
  });

  const searchResultsTreeView = vscode.window.createTreeView('sshLite.searchResults', {
    treeDataProvider: searchResultsProvider,
    showCollapseAll: true,
  });

  // Create preload status bar item
  const preloadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  preloadStatusBar.name = 'SSH Lite Preload';
  preloadStatusBar.command = 'sshLite.cancelPreloading';
  preloadStatusBar.tooltip = 'Click to cancel preloading';
  context.subscriptions.push(preloadStatusBar);

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
    }, 500);
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
    vscode.commands.registerCommand('sshLite.connect', async (item?: HostTreeItem) => {
      try {
        let hostConfig = item?.hostConfig;

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

        log(`Connecting to ${hostConfig.name}...`);
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

        log(`Connected to ${hostConfig.name}`);
        // Auto-dismiss connection success (non-blocking UX)
        vscode.window.setStatusBarMessage(`$(check) Connected to ${hostConfig.name}`, 3000);
      } catch (error) {
        log(`Connection failed: ${(error as Error).message}`);
        const errMsg = (error as Error).message;
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

    vscode.commands.registerCommand('sshLite.disconnect', async (item?: HostTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        // From file explorer
        connection = item.connection;
      } else if (item?.hostConfig) {
        // From host tree
        connection = connectionManager.getConnection(item.hostConfig.id);
      }

      if (!connection) {
        return;
      }

      // Clean up resources
      fileService.cleanupConnection(connection.id);
      terminalService.closeTerminalsForConnection(connection.id);
      await portForwardService.stopAllForwardsForConnection(connection.id);
      fileTreeProvider.clearCache(connection.id);

      await connectionManager.disconnect(connection.id);
      log(`Disconnected from ${connection.host.name}`);
      // Auto-dismiss disconnect success (non-blocking UX)
      vscode.window.setStatusBarMessage(`$(check) Disconnected from ${connection.host.name}`, 3000);
    }),

    vscode.commands.registerCommand('sshLite.addHost', async () => {
      const host = await hostService.promptAddHost();
      if (host) {
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) Added host: ${host.name}`, 3000);
      }
    }),

    vscode.commands.registerCommand('sshLite.editHost', async (item?: HostTreeItem) => {
      if (!item?.hostConfig || item.hostConfig.source !== 'saved') {
        return;
      }

      const host = await hostService.promptEditHost(item.hostConfig);
      if (host) {
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) Updated host: ${host.name}`, 3000);
      }
    }),

    vscode.commands.registerCommand('sshLite.removeHost', async (item?: HostTreeItem) => {
      if (!item?.hostConfig || item.hostConfig.source !== 'saved') {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove host "${item.hostConfig.name}"?`,
        { modal: true },
        'Remove'
      );

      if (confirm === 'Remove') {
        await hostService.removeHost(item.hostConfig.id);
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage(`$(check) Removed host: ${item.hostConfig.name}`, 3000);
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
        await connection.listFiles(targetPath);
        fileTreeProvider.setCurrentPath(connection.id, targetPath);
        log(`Navigated to ${targetPath}`);
      } catch (error) {
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
        vscode.window.showInformationMessage('Already at root');
        return;
      }

      // Get parent path
      const parentPath = currentPath === '~' ? '/' : (require('path').posix.dirname(currentPath) || '/');
      fileTreeProvider.setCurrentPath(connection.id, parentPath);
      log(`Navigated to parent: ${parentPath}`);
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
    }),

    // File commands
    vscode.commands.registerCommand('sshLite.openFile', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        return;
      }

      await fileService.openRemoteFile(item.connection, item.file);
    }),

    vscode.commands.registerCommand('sshLite.downloadFile', async (item?: FileTreeItem) => {
      if (!item) {
        return;
      }

      if (item.file.isDirectory) {
        await fileService.downloadFolder(item.connection, item.file);
      } else {
        await fileService.downloadFileTo(item.connection, item.file);
      }

      fileTreeProvider.refresh();
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

      await fileService.uploadFileTo(connection, remotePath);
      fileTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('sshLite.deleteRemote', async (item?: FileTreeItem) => {
      if (!item) {
        return;
      }

      const deleted = await fileService.deleteRemote(item.connection, item.file);
      if (deleted) {
        fileTreeProvider.refresh();
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

      const created = await fileService.createFolder(connection, parentPath);
      if (created) {
        fileTreeProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('sshLite.refreshFiles', () => {
      fileTreeProvider.refresh();
    }),

    // Filter files in tree view
    vscode.commands.registerCommand('sshLite.filterFiles', async () => {
      const currentFilter = fileTreeProvider.getFilter();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter filter pattern (e.g., *.ts, *.json, config*)',
        placeHolder: '*.ts, *.json, config*, etc.',
        value: currentFilter,
        title: 'Filter Files',
      });

      if (input !== undefined) {
        fileTreeProvider.setFilter(input);
        if (input) {
          vscode.window.setStatusBarMessage(`$(filter) Filter: ${input}`, 3000);
        } else {
          vscode.window.setStatusBarMessage('$(filter) Filter cleared', 2000);
        }
      }
    }),

    // Clear filter
    vscode.commands.registerCommand('sshLite.clearFilter', () => {
      fileTreeProvider.clearFilter();
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

      vscode.window.setStatusBarMessage(`$(search~spin) Searching server for "${currentFilter}"...`, 30000);
      await fileTreeProvider.searchServerForFilter();
      vscode.window.setStatusBarMessage(`$(search) Server search complete`, 3000);
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

      // Add all connections' current paths as default scopes if no scopes exist
      const connections = connectionManager.getAllConnections();
      for (const conn of connections) {
        searchPanel.addScope(fileTreeProvider.getCurrentPath(conn.id), conn);
      }

      searchPanel.show();
      searchPanel.focusSearchInput();
    }),

    // Search in scope - add folder/file to search panel and focus
    vscode.commands.registerCommand('sshLite.searchInScope', async (item?: FileTreeItem | ConnectionTreeItem) => {
      const searchPanel = SearchPanel.getInstance();

      // Set callback for opening files
      searchPanel.setOpenFileCallback(async (connectionId: string, remotePath: string, line?: number) => {
        const connection = connectionManager.getConnection(connectionId);
        if (!connection) {
          vscode.window.showErrorMessage('Connection not found');
          return;
        }

        const remoteFile = {
          name: remotePath.split('/').pop() || remotePath,
          path: remotePath,
          isDirectory: false,
          size: 0,
          modifiedTime: Date.now(),
          connectionId,
        };

        await fileService.openRemoteFile(connection, remoteFile);

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

      // Clear existing scopes and add the selected one
      searchPanel.clearScopes();

      if (item instanceof ConnectionTreeItem) {
        const searchPath = fileTreeProvider.getCurrentPath(item.connection.id);
        searchPanel.addScope(searchPath, item.connection);
      } else if (item instanceof FileTreeItem) {
        const searchPath = item.file.isDirectory
          ? item.file.path
          : item.file.path.substring(0, item.file.path.lastIndexOf('/')) || '/';
        searchPanel.addScope(searchPath, item.connection);
      } else {
        // No item - add all connections' current paths
        const connections = connectionManager.getAllConnections();
        for (const conn of connections) {
          searchPanel.addScope(fileTreeProvider.getCurrentPath(conn.id), conn);
        }
      }

      searchPanel.show();
      searchPanel.focusSearchInput();
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
        fileTreeProvider.setFilenameFilter(pattern, item.file.path, item.connection);
        vscode.commands.executeCommand('setContext', 'sshLite.hasFilenameFilter', true);
        vscode.window.setStatusBarMessage(`$(filter) Filtering: ${pattern} in ${item.file.name}`, 0);
      }
    }),

    // Clear filename filter
    vscode.commands.registerCommand('sshLite.clearFilenameFilter', () => {
      fileTreeProvider.clearFilenameFilter();
      vscode.commands.executeCommand('setContext', 'sshLite.hasFilenameFilter', false);
      vscode.window.setStatusBarMessage('$(filter) Filter cleared', 2000);
    }),

    // Search in file (opens terminal with grep command)
    vscode.commands.registerCommand('sshLite.searchInFile', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to search');
        return;
      }

      const connection = item.connection;
      const filePath = item.file.path;

      // Ask for search pattern
      const searchPattern = await vscode.window.showInputBox({
        prompt: `Search pattern in ${item.file.name}`,
        placeHolder: 'Enter search pattern (regex supported)...',
        title: 'Search in File',
      });

      if (!searchPattern) {
        return;
      }

      // Ask for search options
      const options = await vscode.window.showQuickPick(
        [
          { label: '$(search) Basic Search', description: 'Case-insensitive search', value: 'basic' },
          { label: '$(regex) Regex Search', description: 'Use regular expression', value: 'regex' },
          { label: '$(list-ordered) With Line Numbers', description: 'Show line numbers', value: 'lines' },
          { label: '$(code) With Context', description: 'Show 3 lines of context', value: 'context' },
        ],
        {
          placeHolder: 'Select search mode',
          title: 'Search Options',
        }
      );

      if (!options) {
        return;
      }

      // Build grep command based on options
      let grepCmd = 'grep';
      const escapedPattern = searchPattern.replace(/'/g, "'\\''");
      const escapedPath = filePath.replace(/'/g, "'\\''");

      switch (options.value) {
        case 'basic':
          grepCmd = `grep -i '${escapedPattern}' '${escapedPath}'`;
          break;
        case 'regex':
          grepCmd = `grep -E '${escapedPattern}' '${escapedPath}'`;
          break;
        case 'lines':
          grepCmd = `grep -in '${escapedPattern}' '${escapedPath}'`;
          break;
        case 'context':
          grepCmd = `grep -in -C 3 '${escapedPattern}' '${escapedPath}'`;
          break;
      }

      // Open terminal and run the grep command
      const terminalService = TerminalService.getInstance();
      const terminal = await terminalService.createTerminal(connection);
      terminal.show();
      terminal.sendText(grepCmd);

      log(`Search in file: ${grepCmd}`);
    }),

    // Open search result
    vscode.commands.registerCommand('sshLite.openSearchResult', async (result: SearchResult) => {
      if (!result) {
        return;
      }

      // Create a remote file object
      const remoteFile = {
        name: result.path.split('/').pop() || result.path,
        path: result.path,
        isDirectory: false,
        size: 0,
        modifiedTime: Date.now(),
        connectionId: result.connection.id,
      };

      // Open the file
      await fileService.openRemoteFile(result.connection, remoteFile);

      // If we have a line number, go to that line
      if (result.line) {
        // Wait a bit for the file to open
        setTimeout(async () => {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const position = new vscode.Position(result.line! - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
          }
        }, 300);
      }
    }),

    // Clear search results
    vscode.commands.registerCommand('sshLite.clearSearchResults', () => {
      searchResultsProvider.clear();
    }),

    // Cycle search results sort order
    vscode.commands.registerCommand('sshLite.cycleSearchSort', () => {
      searchResultsProvider.cycleSort();
    }),

    // Reveal search result in file tree
    vscode.commands.registerCommand('sshLite.revealSearchResultInTree', async (item?: SearchResultFileItem | SearchResultMatchItem) => {
      if (!item) {
        return;
      }

      let connectionId: string;
      let remotePath: string;

      if (item instanceof SearchResultFileItem) {
        connectionId = item.connection.id;
        remotePath = item.filePath;
      } else if (item instanceof SearchResultMatchItem) {
        connectionId = item.result.connection.id;
        remotePath = item.result.path;
      } else {
        return;
      }

      // Navigate to parent folder and reveal the file
      const treeItem = await fileTreeProvider.revealFile(connectionId, remotePath);
      if (treeItem) {
        await fileTreeView.reveal(treeItem, { select: true, focus: true, expand: true });
        vscode.window.setStatusBarMessage(`$(go-to-file) Revealed ${treeItem.file.name} in tree`, 3000);
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

      const localPath = activeEditor.document.uri.fsPath;
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
        targetPath = item.file.isDirectory ? item.file.path : require('path').posix.dirname(item.file.path);
      } else {
        return;
      }

      const terminal = await terminalService.createTerminal(connection);
      if (terminal) {
        terminal.sendText(`cd "${targetPath}"`);
      }
    }),

    // Terminal commands
    vscode.commands.registerCommand('sshLite.openTerminal', async (item?: HostTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        // From file explorer
        connection = item.connection;
      } else if (item?.hostConfig) {
        // From host tree
        connection = connectionManager.getConnection(item.hostConfig.id);
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

      await terminalService.createTerminal(connection);
    }),

    // Port forward commands
    vscode.commands.registerCommand('sshLite.forwardPort', async () => {
      await portForwardService.promptForwardPort();
    }),

    vscode.commands.registerCommand('sshLite.stopForward', async (item?: PortForwardTreeItem) => {
      if (!item) {
        return;
      }

      await portForwardService.stopForward(item.forward);
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
    vscode.commands.registerCommand('sshLite.monitor', async (item?: HostTreeItem) => {
      const connection = item?.hostConfig
        ? connectionManager.getConnection(item.hostConfig.id)
        : await selectConnection(connectionManager);

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await showMonitorQuickPick(connection);
    }),

    vscode.commands.registerCommand('sshLite.quickStatus', async (item?: HostTreeItem) => {
      const connection = item?.hostConfig
        ? connectionManager.getConnection(item.hostConfig.id)
        : await selectConnection(connectionManager);

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await monitorService.quickStatus(connection);
    }),

    vscode.commands.registerCommand('sshLite.diagnoseSlowness', async (item?: HostTreeItem) => {
      const connection = item?.hostConfig
        ? connectionManager.getConnection(item.hostConfig.id)
        : await selectConnection(connectionManager);

      if (!connection) {
        vscode.window.showWarningMessage('No active connection selected');
        return;
      }

      await monitorService.diagnoseSlowness(connection);
    }),

    // Simple credential clear command
    vscode.commands.registerCommand('sshLite.clearCredentials', async (item?: HostTreeItem) => {
      if (!item?.hostConfig) {
        vscode.window.showWarningMessage('Select a host first');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Clear saved credentials for ${item.hostConfig.name}?`,
        'Clear'
      );

      if (confirm === 'Clear') {
        await credentialService.deleteAll(item.hostConfig.id);
        hostTreeProvider.refresh();
        vscode.window.setStatusBarMessage('$(check) Credentials cleared', 3000);
      }
    }),

    // Add credential command
    vscode.commands.registerCommand('sshLite.addCredential', async (hostConfig?: IHostConfig) => {
      log(`addCredential: called with hostConfig=${hostConfig ? JSON.stringify({ id: hostConfig.id, name: hostConfig.name }) : 'undefined'}`);
      if (!hostConfig) {
        vscode.window.showWarningMessage('Select a host first');
        return;
      }

      // Ask for credential type
      const typeChoice = await vscode.window.showQuickPick(
        [
          { label: 'Password', description: 'Use password authentication', type: 'password' as const },
          { label: 'Private Key', description: 'Use SSH private key', type: 'privateKey' as const },
        ],
        {
          placeHolder: 'Select authentication type',
          ignoreFocusOut: true,
        }
      );

      if (!typeChoice) return;

      // Ask for label
      const label = await vscode.window.showInputBox({
        prompt: 'Enter a name for this credential',
        placeHolder: 'e.g., Work Password, Personal Key',
        ignoreFocusOut: true,
      });

      if (!label) return;

      if (typeChoice.type === 'password') {
        // Ask for password
        const password = await vscode.window.showInputBox({
          prompt: 'Enter password',
          password: true,
          ignoreFocusOut: true,
        });

        if (!password) return;

        log(`addCredential: Adding password credential "${label}" for host ${hostConfig.id}`);
        try {
          const cred = await credentialService.addCredential(hostConfig.id, label, 'password', password);
          log(`addCredential: Success - created credential ${cred.id}`);
          hostTreeProvider.refresh();
          vscode.window.setStatusBarMessage(`$(check) Credential "${label}" added`, 3000);
        } catch (error) {
          log(`addCredential: Error - ${(error as Error).message}`);
          vscode.window.showErrorMessage(`Failed to add credential: ${(error as Error).message}`);
        }
      } else {
        // Ask for private key path
        const keyUri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: 'Select Private Key File',
          filters: { 'All Files': ['*'] },
        });

        if (!keyUri || keyUri.length === 0) return;

        const keyPath = keyUri[0].fsPath;

        // Check if key is encrypted and ask for passphrase
        const fs = require('fs');
        const keyContent = fs.readFileSync(keyPath, 'utf-8');
        let passphrase = '';

        if (keyContent.includes('ENCRYPTED')) {
          const pass = await vscode.window.showInputBox({
            prompt: 'Enter passphrase for private key (leave empty if none)',
            password: true,
            ignoreFocusOut: true,
          });
          passphrase = pass || '';
        }

        log(`addCredential: Adding privateKey credential "${label}" for host ${hostConfig.id}, keyPath=${keyPath}`);
        try {
          const cred = await credentialService.addCredential(hostConfig.id, label, 'privateKey', passphrase, keyPath);
          log(`addCredential: Success - created credential ${cred.id}`);
          hostTreeProvider.refresh();
          vscode.window.setStatusBarMessage(`$(check) Credential "${label}" added`, 3000);
        } catch (error) {
          log(`addCredential: Error - ${(error as Error).message}`);
          vscode.window.showErrorMessage(`Failed to add credential: ${(error as Error).message}`);
        }
      }
    }),

    // Connect with specific credential
    vscode.commands.registerCommand('sshLite.connectWithCredential', async (hostConfig?: IHostConfig, credential?: SavedCredential) => {
      if (!hostConfig || !credential) {
        vscode.window.showWarningMessage('Invalid credential selection');
        return;
      }

      try {
        log(`Connecting to ${hostConfig.name} with credential "${credential.label}"...`);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connectWithCredential(hostConfig!, credential!);
          }
        );

        log(`Connected to ${hostConfig.name}`);
        // Auto-dismiss connection success (non-blocking UX)
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

    // Delete credential command
    vscode.commands.registerCommand('sshLite.deleteCredential', async (item?: CredentialTreeItem) => {
      if (!item) {
        log('deleteCredential: No item provided');
        vscode.window.showWarningMessage('Select a credential to delete');
        return;
      }

      log(`deleteCredential: Deleting credential "${item.credential.label}" for host "${item.hostConfig.name}" (hostId: ${item.hostConfig.id})`);

      const confirm = await vscode.window.showWarningMessage(
        `Delete credential "${item.credential.label}"?`,
        'Delete'
      );

      if (confirm === 'Delete') {
        try {
          await credentialService.deleteCredential(item.hostConfig.id, item.credential.id);
          hostTreeProvider.refresh();
          vscode.window.setStatusBarMessage('$(check) Credential deleted', 3000);
          log('deleteCredential: Success');
        } catch (error) {
          log(`deleteCredential: Error - ${(error as Error).message}`);
          vscode.window.showErrorMessage(`Failed to delete credential: ${(error as Error).message}`);
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

      // Use host config ID (same as connection.id but more explicit)
      const hostId = connection.host.id;

      // Get all credentials for this host
      const credentials = credentialService.listCredentials(hostId);
      if (credentials.length === 0) {
        vscode.window.showWarningMessage(`No saved credentials for "${connection.host.name}". Add a credential first from SSH Hosts.`);
        return;
      }

      // Let user select which credential to pin to
      const credentialChoice = await vscode.window.showQuickPick(
        credentials.map((c) => ({
          label: c.label,
          description: c.type === 'password' ? 'Password' : 'Private Key',
          credential: c,
        })),
        {
          placeHolder: 'Select credential to pin this folder to',
          ignoreFocusOut: true,
        }
      );

      if (!credentialChoice) return;

      // Ask for a name for this pinned folder
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for this pinned folder',
        value: item.file.name,
        placeHolder: 'e.g., Logs, Config, Projects',
        ignoreFocusOut: true,
      });

      if (!name) return;

      await credentialService.addPinnedFolder(
        hostId,
        credentialChoice.credential.id,
        name,
        remotePath
      );

      hostTreeProvider.refresh();
      vscode.window.setStatusBarMessage(`$(check) Pinned "${name}" to ${credentialChoice.credential.label}`, 3000);
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
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${hostConfig.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connectWithCredential(hostConfig!, credential!);
          }
        );

        // Navigate to the pinned folder
        const connection = connectionManager.getConnection(hostConfig.id);
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
    vscode.commands.registerCommand('sshLite.clearTempFilesForConnection', async (item?: HostTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        // From file explorer
        connection = item.connection;
      } else if (item?.hostConfig) {
        // From host tree
        connection = connectionManager.getConnection(item.hostConfig.id);
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

    // Show combined backup logs (local + server)
    vscode.commands.registerCommand('sshLite.showBackupLogs', async (item?: FileTreeItem) => {
      if (!item || item.file.isDirectory) {
        vscode.window.showWarningMessage('Select a file to view backup logs');
        return;
      }

      await fileService.showBackupLogs(item.connection, item.file.path);
    }),

    // Show all backups UI for a connection
    vscode.commands.registerCommand('sshLite.showAllBackups', async (connection?: SSHConnection | HostTreeItem | ConnectionTreeItem) => {
      let conn: SSHConnection | undefined;

      if (connection instanceof SSHConnection) {
        conn = connection;
      } else if (connection instanceof ConnectionTreeItem) {
        conn = connection.connection;
      } else if (connection && 'hostConfig' in connection) {
        conn = connectionManager.getConnection((connection as HostTreeItem).hostConfig?.id || '');
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
    vscode.commands.registerCommand('sshLite.openServerBackupFolder', async (item?: HostTreeItem | ConnectionTreeItem) => {
      let connection: SSHConnection | undefined;

      if (item instanceof ConnectionTreeItem) {
        connection = item.connection;
      } else if (item?.hostConfig) {
        connection = connectionManager.getConnection(item.hostConfig.id);
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
    hostTreeProvider,
    fileTreeProvider,
    portForwardTreeProvider,
    ...commands
  );

  // Set initial context
  vscode.commands.executeCommand('setContext', 'sshLite.hasConnections', false);
  vscode.commands.executeCommand('setContext', 'sshLite.hasActiveRemoteFile', false);

  // Update context when active editor changes
  const updateActiveFileContext = () => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.commands.executeCommand('setContext', 'sshLite.hasActiveRemoteFile', false);
      return;
    }

    const localPath = activeEditor.document.uri.fsPath;
    const mapping = fileService.getMappingForLocalPath(localPath);

    // Also check temp path structure
    let isRemoteFile = !!mapping;
    if (!isRemoteFile) {
      const tempDir = fileService.getTempDir();
      if (localPath.startsWith(tempDir)) {
        const segments = localPath.substring(tempDir.length).split(/[/\\]/).filter(s => s.length > 0);
        if (segments.length >= 2) {
          const connectionId = segments[0];
          isRemoteFile = !!connectionManager.getConnection(connectionId);
        }
      }
    }

    vscode.commands.executeCommand('setContext', 'sshLite.hasActiveRemoteFile', isRemoteFile);
  };

  // Listen for editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateActiveFileContext)
  );

  // Cancel downloads when document/tab is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      // Check if there's an active download for this document and cancel it
      progressiveDownloadManager.cancelDownloadByUri(document.uri);
    })
  );

  // Update on activation
  updateActiveFileContext();

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
    return doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(tempDir);
  });

  // Also check tab groups for restored tabs that might not be in textDocuments yet
  const tabPaths = new Set<string>();
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const uri = tab.input.uri;
        if (uri.scheme === 'file' && uri.fsPath.startsWith(tempDir)) {
          tabPaths.add(uri.fsPath);
        }
      }
    }
  }

  // Combine both sources
  const allRemotePaths = new Set<string>();
  for (const doc of remoteDocuments) {
    allRemotePaths.add(doc.uri.fsPath);
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
