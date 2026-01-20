import * as vscode from 'vscode';
import { HostService } from '../services/HostService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { CredentialService, SavedCredential, PinnedFolder } from '../services/CredentialService';
import { IHostConfig } from '../types';

/**
 * Tree item representing an SSH host (expandable to show credentials)
 */
export class HostTreeItem extends vscode.TreeItem {
  constructor(
    public readonly hostConfig: IHostConfig,
    public readonly isConnected: boolean
  ) {
    // Hosts are always expandable to show credentials (even when connected)
    super(
      hostConfig.name,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    this.description = `${hostConfig.username}@${hostConfig.host}:${hostConfig.port}`;
    this.tooltip = new vscode.MarkdownString(
      `**${hostConfig.name}**\n\n` +
        `- Host: ${hostConfig.host}\n` +
        `- Port: ${hostConfig.port}\n` +
        `- Username: ${hostConfig.username}\n` +
        `- Source: ${hostConfig.source === 'ssh-config' ? '~/.ssh/config' : 'Saved'}\n` +
        `- Status: ${isConnected ? 'Connected' : 'Disconnected'}`
    );

    // Set context value for menu visibility
    if (isConnected) {
      this.contextValue = 'connectedHost';
      this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'));
    } else if (hostConfig.source === 'saved') {
      this.contextValue = 'savedHost';
      this.iconPath = new vscode.ThemeIcon('vm');
    } else {
      this.contextValue = 'host';
      this.iconPath = new vscode.ThemeIcon('vm-outline');
    }

    // No click command - user expands to see credentials
  }
}

/**
 * Tree item representing a saved credential for a host
 */
export class CredentialTreeItem extends vscode.TreeItem {
  constructor(
    public readonly hostConfig: IHostConfig,
    public readonly credential: SavedCredential,
    hasPinnedFolders: boolean = false,
    isHostConnected: boolean = false
  ) {
    // Expandable if has pinned folders
    super(
      credential.label,
      hasPinnedFolders ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    this.description = credential.type === 'password' ? 'Password' : 'Private Key';
    this.contextValue = isHostConnected ? 'credentialConnected' : 'credential';

    // Icon based on credential type
    if (credential.type === 'password') {
      this.iconPath = new vscode.ThemeIcon('key');
    } else {
      this.iconPath = new vscode.ThemeIcon('file-symlink-file');
    }

    // Only add click-to-connect command if not already connected
    if (isHostConnected) {
      this.tooltip = `${credential.label} (connected)`;
    } else {
      this.tooltip = `Click to connect using ${credential.label}`;
      this.command = {
        command: 'sshLite.connectWithCredential',
        title: 'Connect',
        arguments: [hostConfig, credential],
      };
    }
  }
}

/**
 * Tree item representing a pinned folder for a credential
 */
export class PinnedFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly hostConfig: IHostConfig,
    public readonly credential: SavedCredential,
    public readonly pinnedFolder: PinnedFolder,
    isHostConnected: boolean = false
  ) {
    super(pinnedFolder.name, vscode.TreeItemCollapsibleState.None);

    this.description = pinnedFolder.remotePath;
    this.contextValue = isHostConnected ? 'pinnedFolderConnected' : 'pinnedFolder';
    this.iconPath = new vscode.ThemeIcon('folder');

    if (isHostConnected) {
      // When connected, clicking navigates to the folder
      this.tooltip = `Navigate to ${pinnedFolder.remotePath}`;
      this.command = {
        command: 'sshLite.goToPath',
        title: 'Go to Folder',
        arguments: [hostConfig, pinnedFolder.remotePath],
      };
    } else {
      // When disconnected, clicking connects and navigates
      this.tooltip = `Connect and open ${pinnedFolder.remotePath}`;
      this.command = {
        command: 'sshLite.connectToPinnedFolder',
        title: 'Connect to Folder',
        arguments: [hostConfig, credential, pinnedFolder],
      };
    }
  }
}

/**
 * Tree item for adding new credential
 */
export class AddCredentialTreeItem extends vscode.TreeItem {
  constructor(public readonly hostConfig: IHostConfig) {
    super('Add Credential...', vscode.TreeItemCollapsibleState.None);

    this.tooltip = 'Add a new credential for this host';
    this.contextValue = 'addCredential';
    this.iconPath = new vscode.ThemeIcon('add');

    // Click to add credential
    this.command = {
      command: 'sshLite.addCredential',
      title: 'Add Credential',
      arguments: [hostConfig],
    };
  }
}

type TreeItemType = HostTreeItem | CredentialTreeItem | AddCredentialTreeItem | PinnedFolderTreeItem;

/**
 * Tree data provider for SSH hosts
 */
export class HostTreeProvider implements vscode.TreeDataProvider<TreeItemType> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItemType | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private hostService: HostService;
  private connectionManager: ConnectionManager;
  private credentialService: CredentialService;

  constructor() {
    this.hostService = HostService.getInstance();
    this.connectionManager = ConnectionManager.getInstance();
    this.credentialService = CredentialService.getInstance();

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
   * Get tree item representation
   */
  getTreeItem(element: TreeItemType): vscode.TreeItem {
    return element;
  }

  /**
   * Get children (hosts or credentials) - synchronous for instant UI
   */
  getChildren(element?: TreeItemType): TreeItemType[] {
    // Root level: show hosts
    if (!element) {
      const hosts = this.hostService.getAllHosts();
      const connections = this.connectionManager.getAllConnections();
      const connectedIds = new Set(connections.map((c) => c.id));

      return hosts.map((host) => new HostTreeItem(host, connectedIds.has(host.id)));
    }

    // Host level: show credentials (for both connected and disconnected hosts)
    if (element instanceof HostTreeItem) {
      const credentials = this.credentialService.listCredentials(element.hostConfig.id);
      const items: TreeItemType[] = [];

      // Add saved credentials
      for (const cred of credentials) {
        const hasPinnedFolders = (cred.pinnedFolders?.length || 0) > 0;
        items.push(new CredentialTreeItem(element.hostConfig, cred, hasPinnedFolders, element.isConnected));
      }

      // Add "Add Credential" item
      items.push(new AddCredentialTreeItem(element.hostConfig));

      return items;
    }

    // Credential level: show pinned folders
    if (element instanceof CredentialTreeItem) {
      const pinnedFolders = element.credential.pinnedFolders || [];
      const connections = this.connectionManager.getAllConnections();
      const isConnected = connections.some((c) => c.id === element.hostConfig.id);
      return pinnedFolders.map(
        (folder) => new PinnedFolderTreeItem(element.hostConfig, element.credential, folder, isConnected)
      );
    }

    return [];
  }

  /**
   * Get parent element
   */
  getParent(element: TreeItemType): vscode.ProviderResult<TreeItemType> {
    if (element instanceof CredentialTreeItem || element instanceof AddCredentialTreeItem) {
      // Return the parent host - but we need to find it
      return undefined; // VS Code will handle this
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
