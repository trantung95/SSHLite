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
import { HostTreeProvider, HostTreeItem } from './providers/HostTreeProvider';
import { FileTreeProvider, FileTreeItem, ConnectionTreeItem } from './providers/FileTreeProvider';
import { PortForwardTreeProvider, PortForwardTreeItem } from './providers/PortForwardTreeProvider';

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

    // Navigation commands
    vscode.commands.registerCommand('sshLite.goToPath', async (connectionOrItem?: SSHConnection | ConnectionTreeItem | FileTreeItem, pathArg?: string) => {
      let connection: SSHConnection | undefined;

      // Handle different argument types
      if (connectionOrItem instanceof SSHConnection) {
        connection = connectionOrItem;
      } else if (connectionOrItem instanceof ConnectionTreeItem) {
        connection = connectionOrItem.connection;
      } else if (connectionOrItem instanceof FileTreeItem) {
        connection = connectionOrItem.connection;
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
        vscode.window.showInformationMessage('Audit log cleared');
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
        vscode.window.showInformationMessage('Credentials cleared');
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
  const credentialService = CredentialService.getInstance();
  const auditService = AuditService.getInstance();
  const monitorService = ServerMonitorService.getInstance();

  fileService.dispose();
  terminalService.dispose();
  credentialService.dispose();
  auditService.dispose();
  monitorService.dispose();
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
