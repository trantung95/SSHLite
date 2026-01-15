import * as vscode from 'vscode';
import { ConnectionManager } from './connection/ConnectionManager';
import { HostService } from './services/HostService';
import { FileService } from './services/FileService';
import { TerminalService } from './services/TerminalService';
import { PortForwardService } from './services/PortForwardService';
import { HostTreeProvider, HostTreeItem } from './providers/HostTreeProvider';
import { FileTreeProvider, FileTreeItem, ConnectionTreeItem } from './providers/FileTreeProvider';
import { PortForwardTreeProvider, PortForwardTreeItem } from './providers/PortForwardTreeProvider';

let outputChannel: vscode.OutputChannel;

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

  // Create tree providers
  const hostTreeProvider = new HostTreeProvider();
  const fileTreeProvider = new FileTreeProvider();
  const portForwardTreeProvider = new PortForwardTreeProvider();

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
  });

  const portForwardTreeView = vscode.window.createTreeView('sshLite.portForwards', {
    treeDataProvider: portForwardTreeProvider,
    showCollapseAll: false,
  });

  // Register commands
  const commands = [
    // Host commands
    vscode.commands.registerCommand('sshLite.connect', async (item?: HostTreeItem) => {
      try {
        let hostConfig = item?.hostConfig;

        if (!hostConfig) {
          // Show quick pick to select host
          const hosts = await hostService.getAllHosts();
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
        vscode.window.showInformationMessage(`Connected to ${hostConfig.name}`);
      } catch (error) {
        log(`Connection failed: ${(error as Error).message}`);
        vscode.window.showErrorMessage(`Connection failed: ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.disconnect', async (item?: HostTreeItem) => {
      if (!item?.hostConfig) {
        return;
      }

      const connection = connectionManager.getConnection(item.hostConfig.id);
      if (connection) {
        // Clean up resources
        fileService.cleanupConnection(connection.id);
        terminalService.closeTerminalsForConnection(connection.id);
        await portForwardService.stopAllForwardsForConnection(connection.id);

        await connectionManager.disconnect(item.hostConfig.id);
        log(`Disconnected from ${item.hostConfig.name}`);
        vscode.window.showInformationMessage(`Disconnected from ${item.hostConfig.name}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.addHost', async () => {
      const host = await hostService.promptAddHost();
      if (host) {
        hostTreeProvider.refresh();
        vscode.window.showInformationMessage(`Added host: ${host.name}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.editHost', async (item?: HostTreeItem) => {
      if (!item?.hostConfig || item.hostConfig.source !== 'saved') {
        return;
      }

      const host = await hostService.promptEditHost(item.hostConfig);
      if (host) {
        hostTreeProvider.refresh();
        vscode.window.showInformationMessage(`Updated host: ${host.name}`);
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
        vscode.window.showInformationMessage(`Removed host: ${item.hostConfig.name}`);
      }
    }),

    vscode.commands.registerCommand('sshLite.refreshHosts', () => {
      hostTreeProvider.refresh();
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

    // Terminal commands
    vscode.commands.registerCommand('sshLite.openTerminal', async (item?: HostTreeItem) => {
      if (!item?.hostConfig) {
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

        await terminalService.createTerminal(selected.connection);
        return;
      }

      const connection = connectionManager.getConnection(item.hostConfig.id);
      if (!connection) {
        vscode.window.showWarningMessage('Not connected to this host');
        return;
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

  log('SSH Lite extension activated');
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

  fileService.dispose();
  terminalService.dispose();
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
