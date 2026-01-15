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
  constructor(public readonly connection: SSHConnection) {
    super(connection.host.name, vscode.TreeItemCollapsibleState.Expanded);

    this.description = `${connection.host.username}@${connection.host.host}`;
    this.contextValue = 'connection';
    this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'));
  }
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

type TreeItem = ConnectionTreeItem | FileTreeItem;

/**
 * Tree data provider for remote file explorer
 */
export class FileTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connectionManager: ConnectionManager;
  private expandedPaths: Map<string, string> = new Map(); // connectionId -> current path

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();

    // Refresh when connections change
    this.connectionManager.onDidChangeConnections(() => {
      this.refresh();
    });
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
      return connections.map((conn) => new ConnectionTreeItem(conn));
    }

    // Connection level: show root directory files
    if (element instanceof ConnectionTreeItem) {
      const config = vscode.workspace.getConfiguration('sshLite');
      const defaultPath = config.get<string>('defaultRemotePath', '~');

      try {
        const files = await element.connection.listFiles(defaultPath);
        return files.map((file) => new FileTreeItem(file, element.connection));
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
    this._onDidChangeTreeData.dispose();
  }
}
