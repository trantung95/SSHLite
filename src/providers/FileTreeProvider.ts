import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { formatFileSize } from '../utils/helpers';
import { FolderHistoryService } from '../services/FolderHistoryService';

/**
 * Cache entry for directory listing
 */
interface CacheEntry {
  files: IRemoteFile[];
  timestamp: number;
}

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

    // Set icon based on type
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
  private folderHistoryService: FolderHistoryService;
  private currentPaths: Map<string, string> = new Map(); // connectionId -> current path
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private configChangeListener: vscode.Disposable;

  // Custom status bar item for loading indicator
  private loadingStatusBar: vscode.StatusBarItem;

  // Directory cache: connectionId:path -> CacheEntry
  private directoryCache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 30000; // 30 seconds cache TTL

  // Track active loading operations to avoid duplicates
  private activeLoads: Map<string, Promise<IRemoteFile[]>> = new Map();

  // Track pending preload operations
  private preloadQueue: Set<string> = new Set();

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();
    this.folderHistoryService = FolderHistoryService.getInstance();

    // Create custom status bar item (priority 100 = high, aligned left)
    this.loadingStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.loadingStatusBar.name = 'SSH Lite Loading';

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
   * Show loading indicator in status bar
   */
  private showLoading(message: string): void {
    this.loadingStatusBar.text = `$(sync~spin) ${message}`;
    this.loadingStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.loadingStatusBar.tooltip = `SSH Lite: ${message}`;
    this.loadingStatusBar.show();
  }

  /**
   * Show success indicator in status bar (briefly)
   */
  private showSuccess(message: string): void {
    this.loadingStatusBar.text = `$(check) ${message}`;
    this.loadingStatusBar.backgroundColor = undefined;
    this.loadingStatusBar.tooltip = `SSH Lite: ${message}`;
    this.loadingStatusBar.show();

    // Hide after 2 seconds
    setTimeout(() => {
      this.loadingStatusBar.hide();
    }, 2000);
  }

  /**
   * Hide loading indicator
   */
  private hideLoading(): void {
    this.loadingStatusBar.hide();
  }

  /**
   * Get cache key for a connection and path
   */
  private getCacheKey(connectionId: string, remotePath: string): string {
    return `${connectionId}:${remotePath}`;
  }

  /**
   * Get cached directory listing if valid
   */
  private getCached(connectionId: string, remotePath: string): IRemoteFile[] | null {
    const key = this.getCacheKey(connectionId, remotePath);
    const entry = this.directoryCache.get(key);
    if (entry && Date.now() - entry.timestamp < this.CACHE_TTL_MS) {
      return entry.files;
    }
    return null;
  }

  /**
   * Store directory listing in cache
   */
  private setCache(connectionId: string, remotePath: string, files: IRemoteFile[]): void {
    const key = this.getCacheKey(connectionId, remotePath);
    this.directoryCache.set(key, { files, timestamp: Date.now() });
  }

  /**
   * Clear cache for a specific connection or all
   */
  clearCache(connectionId?: string): void {
    if (connectionId) {
      const prefix = `${connectionId}:`;
      for (const key of this.directoryCache.keys()) {
        if (key.startsWith(prefix)) {
          this.directoryCache.delete(key);
        }
      }
    } else {
      this.directoryCache.clear();
    }
  }

  /**
   * Load directory with deduplication and caching
   */
  private async loadDirectory(
    connection: SSHConnection,
    remotePath: string,
    useCache: boolean = true
  ): Promise<IRemoteFile[]> {
    const cacheKey = this.getCacheKey(connection.id, remotePath);

    // Return cached if valid
    if (useCache) {
      const cached = this.getCached(connection.id, remotePath);
      if (cached) {
        return cached;
      }
    }

    // Check if already loading this directory
    const existingLoad = this.activeLoads.get(cacheKey);
    if (existingLoad) {
      return existingLoad;
    }

    // Start new load
    const loadPromise = connection.listFiles(remotePath).then((files) => {
      this.setCache(connection.id, remotePath, files);
      this.activeLoads.delete(cacheKey);
      return files;
    }).catch((error) => {
      this.activeLoads.delete(cacheKey);
      throw error;
    });

    this.activeLoads.set(cacheKey, loadPromise);
    return loadPromise;
  }

  /**
   * Preload subdirectories in background (non-blocking)
   */
  private preloadSubdirectories(connection: SSHConnection, files: IRemoteFile[]): void {
    // Get directories to preload (limit to first 5 to avoid overload)
    const directories = files
      .filter((f) => f.isDirectory)
      .slice(0, 5);

    if (directories.length === 0) return;

    // Preload in parallel, silently in background
    for (const dir of directories) {
      const cacheKey = this.getCacheKey(connection.id, dir.path);

      // Skip if already cached or being loaded or in preload queue
      if (this.getCached(connection.id, dir.path) ||
          this.activeLoads.has(cacheKey) ||
          this.preloadQueue.has(cacheKey)) {
        continue;
      }

      this.preloadQueue.add(cacheKey);

      // Load in background without blocking
      this.loadDirectory(connection, dir.path, true)
        .catch(() => { /* Silently ignore preload errors */ })
        .finally(() => {
          this.preloadQueue.delete(cacheKey);
        });
    }
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

    // Record folder visit for smart preloading
    this.folderHistoryService.recordVisit(connectionId, newPath);

    // Preload the new path immediately for faster rendering
    const connection = this.connectionManager.getConnection(connectionId);
    if (connection && !this.getCached(connectionId, newPath)) {
      this.loadDirectory(connection, newPath, true).catch(() => {
        /* Ignore preload errors */
      });
    }

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
   * @param clearCache - Whether to clear the cache before refreshing (default: false)
   */
  refresh(clearCache: boolean = false): void {
    if (clearCache) {
      this.directoryCache.clear();
    }
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh a specific item
   * @param clearCache - Whether to clear cache for this item's path
   */
  refreshItem(item: TreeItem, clearCache: boolean = false): void {
    if (clearCache) {
      if (item instanceof ConnectionTreeItem) {
        this.clearCache(item.connection.id);
      } else if (item instanceof FileTreeItem) {
        const key = this.getCacheKey(item.connection.id, item.file.path);
        this.directoryCache.delete(key);
      }
    }
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

      // Preload current directory for all connections in parallel
      this.preloadConnectionDirectories(connections);

      return connections.map((conn) => {
        const currentPath = this.getCurrentPath(conn.id);
        return new ConnectionTreeItem(conn, currentPath);
      });
    }

    // Connection level: show current directory files
    if (element instanceof ConnectionTreeItem) {
      const currentPath = this.getCurrentPath(element.connection.id);

      // Check cache first - if cached, no loading indicator needed
      const cached = this.getCached(element.connection.id, currentPath);
      if (cached) {
        const items = this.buildDirectoryItems(element.connection, currentPath, cached);
        // Preload subdirectories in background
        this.preloadSubdirectories(element.connection, cached);
        return items;
      }

      // Show loading indicator (use setTimeout to avoid blocking tree render)
      setTimeout(() => this.showLoading(`Loading ${currentPath}...`), 0);

      try {
        const files = await this.loadDirectory(element.connection, currentPath, false);
        const items = this.buildDirectoryItems(element.connection, currentPath, files);

        // Preload subdirectories in background
        this.preloadSubdirectories(element.connection, files);

        this.showSuccess(`Loaded ${currentPath}`);
        return items;
      } catch (error) {
        this.hideLoading();
        vscode.window.showErrorMessage(`Failed to list files: ${(error as Error).message}`);
        return [];
      }
    }

    // File level: show directory contents
    if (element instanceof FileTreeItem && element.file.isDirectory) {
      // Check cache first
      const cached = this.getCached(element.connection.id, element.file.path);
      if (cached) {
        const items = cached.map((file) => new FileTreeItem(file, element.connection));
        // Preload subdirectories in background
        this.preloadSubdirectories(element.connection, cached);
        return items;
      }

      // Show loading indicator (use setTimeout to avoid blocking tree render)
      setTimeout(() => this.showLoading(`Loading ${element.file.name}...`), 0);

      try {
        const files = await this.loadDirectory(element.connection, element.file.path, false);
        const items = files.map((file) => new FileTreeItem(file, element.connection));

        // Preload subdirectories in background
        this.preloadSubdirectories(element.connection, files);

        this.showSuccess(`Loaded ${element.file.name}`);
        return items;
      } catch (error) {
        this.hideLoading();
        vscode.window.showErrorMessage(`Failed to list directory: ${(error as Error).message}`);
        return [];
      }
    }

    return [];
  }

  /**
   * Build tree items for a directory listing
   */
  private buildDirectoryItems(
    connection: SSHConnection,
    currentPath: string,
    files: IRemoteFile[]
  ): TreeItem[] {
    const items: TreeItem[] = [];

    // Add parent folder navigation if not at root
    if (currentPath !== '/' && currentPath !== '~') {
      const parentPath = path.posix.dirname(currentPath);
      items.push(new ParentFolderTreeItem(connection, parentPath || '/'));
    } else if (currentPath === '~') {
      // Allow going to root from home
      items.push(new ParentFolderTreeItem(connection, '/'));
    }

    // Add files
    items.push(...files.map((file) => new FileTreeItem(file, connection)));

    return items;
  }

  /**
   * Preload current directories for all connections in parallel
   * Also preloads frequently used folders from history
   */
  private preloadConnectionDirectories(connections: SSHConnection[]): void {
    for (const conn of connections) {
      const currentPath = this.getCurrentPath(conn.id);

      // Only preload if not already cached
      if (!this.getCached(conn.id, currentPath)) {
        this.loadDirectory(conn, currentPath, true).catch(() => {
          /* Silently ignore preload errors */
        });
      }

      // Preload frequently used folders from history (top 5)
      this.preloadFrequentFolders(conn);
    }
  }

  /**
   * Preload frequently used folders from history
   */
  private preloadFrequentFolders(connection: SSHConnection): void {
    const frequentFolders = this.folderHistoryService.getFrequentFolders(connection.id, 5);

    for (const folderPath of frequentFolders) {
      const cacheKey = this.getCacheKey(connection.id, folderPath);

      // Skip if already cached, loading, or in preload queue
      if (
        this.getCached(connection.id, folderPath) ||
        this.activeLoads.has(cacheKey) ||
        this.preloadQueue.has(cacheKey)
      ) {
        continue;
      }

      this.preloadQueue.add(cacheKey);

      // Load in background without blocking
      this.loadDirectory(connection, folderPath, true)
        .catch(() => {
          /* Silently ignore preload errors */
        })
        .finally(() => {
          this.preloadQueue.delete(cacheKey);
        });
    }
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
    this.loadingStatusBar.dispose();
    this.directoryCache.clear();
    this.activeLoads.clear();
    this.preloadQueue.clear();
  }
}
