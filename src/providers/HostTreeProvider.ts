import * as vscode from 'vscode';
import * as path from 'path';
import { HostService } from '../services/HostService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { CredentialService, SavedCredential, PinnedFolder } from '../services/CredentialService';
import { IHostConfig } from '../types';

// Get extension path for custom icons
let extensionPath: string = '';
export function setExtensionPath(extPath: string): void {
  extensionPath = extPath;
}

/**
 * Get server key (host:port) for grouping
 */
function getServerKey(host: IHostConfig): string {
  return `${host.host}:${host.port}`;
}

/**
 * Tree item representing a server (host:port), expandable to show credentials/usernames
 */
export class ServerTreeItem extends vscode.TreeItem {
  public readonly serverKey: string;
  public readonly hosts: IHostConfig[]; // All host configs for this server (different usernames)
  public readonly isConnected: boolean;

  constructor(
    serverKey: string,
    hosts: IHostConfig[],
    isConnected: boolean
  ) {
    // Use first host's name as display name
    const displayName = hosts[0].name;

    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);

    this.serverKey = serverKey;
    this.hosts = hosts;
    this.isConnected = isConnected;

    // Stable ID - don't include connection state to preserve expansion state
    // VS Code uses ID to track tree item identity; changing ID resets expansion
    this.id = `server:${serverKey}`;

    // Description shows host:port only (no username)
    this.description = serverKey;

    // Tooltip with server info
    const usernames = hosts.map(h => h.username).join(', ');
    this.tooltip = new vscode.MarkdownString(
      `**${displayName}**\n\n` +
        `- Server: ${serverKey}\n` +
        `- Users: ${usernames}\n` +
        `- Status: ${isConnected ? 'Connected' : 'Disconnected'}`
    );

    // Set context value and icon based on connection status
    // Always use ThemeIcon to avoid VS Code SVG caching issues
    // Check for actual saved credentials in CredentialService (not just host config source)
    const credentialService = CredentialService.getInstance();
    const hasSavedCredential = hosts.some(h => credentialService.listCredentials(h.id).length > 0);

    if (isConnected) {
      this.contextValue = 'connectedServer';
      this.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('charts.green'));
    } else if (hasSavedCredential) {
      this.contextValue = 'savedServer';
      this.iconPath = new vscode.ThemeIcon('vm');
    } else {
      this.contextValue = 'server';
      this.iconPath = new vscode.ThemeIcon('vm-outline');
    }
  }

  /**
   * Get the primary host config (first one, usually the one user interacts with most)
   */
  get primaryHost(): IHostConfig {
    return this.hosts[0];
  }
}

/**
 * Tree item representing a username/credential for a server
 */
export class UserCredentialTreeItem extends vscode.TreeItem {
  constructor(
    public readonly hostConfig: IHostConfig,
    public readonly credential: SavedCredential | null, // null if no saved credential
    public readonly isConnected: boolean,
    hasPinnedFolders: boolean = false
  ) {
    // Show username as label
    super(
      hostConfig.username,
      hasPinnedFolders ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    // Description shows credential type if saved
    if (credential) {
      this.description = credential.type === 'password' ? 'Password saved' : 'Private Key';
    } else {
      this.description = 'No password saved';
    }

    this.contextValue = isConnected ? 'credentialConnected' : 'credential';

    // Icon based on credential status
    if (credential) {
      this.iconPath = new vscode.ThemeIcon('key');
    } else {
      this.iconPath = new vscode.ThemeIcon('person');
    }

    // Tooltip
    if (isConnected) {
      this.tooltip = `${hostConfig.username} (connected)`;
    } else {
      this.tooltip = `Click to connect as ${hostConfig.username}`;
      // Click to connect
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
 * Tree item for adding new credential/user
 */
export class AddCredentialTreeItem extends vscode.TreeItem {
  constructor(public readonly serverItem: ServerTreeItem) {
    super('Add User...', vscode.TreeItemCollapsibleState.None);

    this.tooltip = 'Add a new user credential for this server';
    this.contextValue = 'addCredential';
    this.iconPath = new vscode.ThemeIcon('add');

    // Click to add credential
    this.command = {
      command: 'sshLite.addCredential',
      title: 'Add Credential',
      arguments: [serverItem],
    };
  }
}

// Legacy exports for compatibility
export { ServerTreeItem as HostTreeItem };
export class CredentialTreeItem extends UserCredentialTreeItem {
  constructor(
    hostConfig: IHostConfig,
    credential: SavedCredential,
    hasPinnedFolders: boolean = false,
    isHostConnected: boolean = false
  ) {
    super(hostConfig, credential, isHostConnected, hasPinnedFolders);
  }
}

type TreeItemType = ServerTreeItem | UserCredentialTreeItem | AddCredentialTreeItem | PinnedFolderTreeItem;

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
   * Get children - synchronous for instant UI
   */
  getChildren(element?: TreeItemType): TreeItemType[] {
    // Root level: show servers (grouped by host:port)
    if (!element) {
      return this.getServerItems();
    }

    // Server level: show user credentials
    if (element instanceof ServerTreeItem) {
      return this.getUserCredentialItems(element);
    }

    // User credential level: show pinned folders
    if (element instanceof UserCredentialTreeItem && element.credential) {
      const pinnedFolders = element.credential.pinnedFolders || [];
      return pinnedFolders.map(
        (folder) => new PinnedFolderTreeItem(element.hostConfig, element.credential!, folder, element.isConnected)
      );
    }

    return [];
  }

  /**
   * Get server items grouped by host:port
   */
  private getServerItems(): ServerTreeItem[] {
    const hosts = this.hostService.getAllHosts();
    const connections = this.connectionManager.getAllConnections();
    const connectedIds = new Set(connections.map((c) => c.id));

    // DEBUG: Log connections on startup
    if (connections.length > 0) {
      console.log('[SSH Lite] getServerItems - Active connections:', connections.map(c => c.id));
    }

    // Group hosts by server key (host:port)
    const serverMap = new Map<string, IHostConfig[]>();
    for (const host of hosts) {
      const key = getServerKey(host);
      if (!serverMap.has(key)) {
        serverMap.set(key, []);
      }
      serverMap.get(key)!.push(host);
    }

    // Create server items
    const items: ServerTreeItem[] = [];
    for (const [serverKey, serverHosts] of serverMap) {
      // Check if any username for this server is connected
      const isConnected = serverHosts.some(h => connectedIds.has(h.id));
      items.push(new ServerTreeItem(serverKey, serverHosts, isConnected));
    }

    return items;
  }

  /**
   * Get user credential items for a server
   */
  private getUserCredentialItems(serverItem: ServerTreeItem): TreeItemType[] {
    const items: TreeItemType[] = [];
    const connections = this.connectionManager.getAllConnections();
    const connectedIds = new Set(connections.map((c) => c.id));

    // Add each username as a credential item
    for (const host of serverItem.hosts) {
      const isConnected = connectedIds.has(host.id);

      // Get saved credentials for this specific host config
      const credentials = this.credentialService.listCredentials(host.id);
      const primaryCredential = credentials.length > 0 ? credentials[0] : null;
      const hasPinnedFolders = primaryCredential?.pinnedFolders?.length ? primaryCredential.pinnedFolders.length > 0 : false;

      items.push(new UserCredentialTreeItem(host, primaryCredential, isConnected, hasPinnedFolders));
    }

    // Add "Add User" item
    items.push(new AddCredentialTreeItem(serverItem));

    return items;
  }

  /**
   * Get parent element
   */
  getParent(element: TreeItemType): vscode.ProviderResult<TreeItemType> {
    // VS Code will handle parent resolution
    return undefined;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
