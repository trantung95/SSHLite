import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { formatFileSize } from '../utils/helpers';

/**
 * Tree item representing a connection root
 */
export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connection: SSHConnection,
    public readonly currentPath: string = '~'
  ) {
    super(connection.host.name, vscode.TreeItemCollapsibleState.Expanded);

    this.description = `${connection.host.username}@${connection.host.host} - ${currentPath}`;
    this.contextValue = 'connection';
    this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'));
  }
}

/**
 * Tree item for navigating to parent directory
 */
export class ParentFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connection: SSHConnection,
    public readonly parentPath: string
  ) {
    super('..', vscode.TreeItemCollapsibleState.None);

    this.description = 'Go to parent folder';
    this.contextValue = 'parentFolder';
    this.iconPath = new vscode.ThemeIcon('folder-opened');
    this.command = {
      command: 'sshLite.goToPath',
      title: 'Go to Parent',
      arguments: [connection, parentPath],
    };
  }
}

/**
 * Get the auto-refresh interval from configuration
 */
function getRefreshInterval(): number {
  const config = vscode.workspace.getConfiguration('sshLite');
  return config.get<number>('treeRefreshIntervalSeconds', 0);
}

/**
 * Tree item representing a remote file or directory
 */
export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly file: IRemoteFile,
    public readonly connection: SSHConnection
  ) {
    super(
      file.name,
      file.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.resourceUri = vscode.Uri.parse(`ssh://${connection.id}${file.path}`);
    this.contextValue = file.isDirectory ? 'folder' : 'file';

    if (file.isDirectory) {
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      this.iconPath = vscode.ThemeIcon.File;
    }

    // Format file size
    const sizeStr = file.isDirectory ? '' : formatFileSize(file.size);
    this.description = sizeStr;

    // Tooltip with more details
    const date = new Date(file.modifiedTime);
    this.tooltip = new vscode.MarkdownString(
      `**${file.name}**\n\n` +
        `- Path: ${file.path}\n` +
        `- Size: ${sizeStr || 'Directory'}\n` +
        `- Modified: ${date.toLocaleString()}`
    );

    // Double-click to open file
    if (!file.isDirectory) {
      this.command = {
        command: 'sshLite.openFile',
        title: 'Open File',
        arguments: [this],
      };
    }
  }
}

type TreeItem = ConnectionTreeItem | FileTreeItem | ParentFolderTreeItem;

/**
 * Tree data provider for remote file explorer
 */
export class FileTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connectionManager: ConnectionManager;
  private currentPaths: Map<string, string> = new Map(); // connectionId -> current path
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private configChangeListener: vscode.Disposable;

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();

    // Refresh when connections change
    this.connectionManager.onDidChangeConnections(() => {
      this.refresh();
    });

    // Start auto-refresh timer if configured
    this.startAutoRefresh();

    // Listen for configuration changes
    this.configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshLite.treeRefreshIntervalSeconds')) {
        this.restartAutoRefresh();
      }
    });
  }

  /**
   * Get current path for a connection
   */
  getCurrentPath(connectionId: string): string {
    return this.currentPaths.get(connectionId) || '~';
  }

  /**
   * Set current path for a connection and refresh
   */
  setCurrentPath(connectionId: string, newPath: string): void {
    this.currentPaths.set(connectionId, newPath);
    this.refresh();
  }

  /**
   * Start the auto-refresh timer based on configuration
   */
  private startAutoRefresh(): void {
    const intervalSeconds = getRefreshInterval();
    if (intervalSeconds > 0) {
      const intervalMs = intervalSeconds * 1000;
      this.refreshTimer = setInterval(() => {
        // Only refresh if there are active connections
        if (this.connectionManager.getAllConnections().length > 0) {
          this.refresh();
        }
      }, intervalMs);
    }
  }

  /**
   * Stop the auto-refresh timer
   */
  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Restart the auto-refresh timer (called when config changes)
   */
  private restartAutoRefresh(): void {
    this.stopAutoRefresh();
    this.startAutoRefresh();
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh a specific item
   */
  refreshItem(item: TreeItem): void {
    this._onDidChangeTreeData.fire(item);
  }

  /**
   * Get tree item representation
   */
  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children
   */
  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    // Root level: show all connections
    if (!element) {
      const connections = this.connectionManager.getAllConnections();
      return connections.map((conn) => {
        const currentPath = this.getCurrentPath(conn.id);
        return new ConnectionTreeItem(conn, currentPath);
      });
    }

    // Connection level: show current directory files
    if (element instanceof ConnectionTreeItem) {
      const currentPath = this.getCurrentPath(element.connection.id);

      try {
        const files = await element.connection.listFiles(currentPath);
        const items: TreeItem[] = [];

        // Add parent folder navigation if not at root
        if (currentPath !== '/' && currentPath !== '~') {
          const parentPath = path.posix.dirname(currentPath);
          items.push(new ParentFolderTreeItem(element.connection, parentPath || '/'));
        } else if (currentPath === '~') {
          // Allow going to root from home
          items.push(new ParentFolderTreeItem(element.connection, '/'));
        }

        // Add files
        items.push(...files.map((file) => new FileTreeItem(file, element.connection)));
        return items;
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to list files: ${(error as Error).message}`);
        return [];
      }
    }

    // File level: show directory contents
    if (element instanceof FileTreeItem && element.file.isDirectory) {
      try {
        const files = await element.connection.listFiles(element.file.path);
        return files.map((file) => new FileTreeItem(file, element.connection));
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to list directory: ${(error as Error).message}`);
        return [];
      }
    }

    return [];
  }

  /**
   * Get parent element
   */
  getParent(element: TreeItem): vscode.ProviderResult<TreeItem> {
    if (element instanceof FileTreeItem) {
      const parentPath = path.dirname(element.file.path);
      if (parentPath === element.file.path || parentPath === '.' || parentPath === '/') {
        // Return connection root
        return new ConnectionTreeItem(element.connection);
      }
      // Note: Returning undefined here - VS Code will handle navigation
      return undefined;
    }
    return undefined;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.stopAutoRefresh();
    this.configChangeListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
