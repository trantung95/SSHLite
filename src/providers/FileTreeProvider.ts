import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { formatFileSize, formatRelativeTime, formatDateTime } from '../utils/helpers';
import { FolderHistoryService } from '../services/FolderHistoryService';
import { FileService } from '../services/FileService';

// Get extension path for custom icons
let extensionPath: string = '';
export function setFileTreeExtensionPath(extPath: string): void {
  extensionPath = extPath;
}

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

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `connection:${connection.id}`;
    this.description = `${connection.host.username}@${connection.host.host} - ${currentPath}`;
    this.contextValue = 'connection';
    // Use custom SVG icon with green color baked in (persists when selected)
    if (extensionPath) {
      this.iconPath = {
        light: vscode.Uri.file(path.join(extensionPath, 'images', 'vm-connected.svg')),
        dark: vscode.Uri.file(path.join(extensionPath, 'images', 'vm-connected.svg')),
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'));
    }
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

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `parent:${connection.id}:${parentPath}`;
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
    public readonly connection: SSHConnection,
    public readonly isHighlighted: boolean = false
  ) {
    super(
      file.name,
      file.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `file:${connection.id}:${file.path}`;
    this.resourceUri = vscode.Uri.parse(`ssh://${connection.id}${file.path}`);
    this.contextValue = file.isDirectory ? 'folder' : 'file';

    // Set icon based on type, with highlighting for filename filter matches
    if (file.isDirectory) {
      this.iconPath = isHighlighted
        ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'))
        : vscode.ThemeIcon.Folder;
    } else {
      this.iconPath = isHighlighted
        ? new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.yellow'))
        : vscode.ThemeIcon.File;
    }

    // Format description: size + relative modified time (grayed out by VS Code)
    const sizeStr = file.isDirectory ? '' : formatFileSize(file.size);
    const timeStr = formatRelativeTime(file.modifiedTime);
    this.description = file.isDirectory ? timeStr : `${sizeStr}  ${timeStr}`;

    // Tooltip with more details including times, owner, and permissions
    const modifiedStr = formatDateTime(file.modifiedTime);
    const accessStr = file.accessTime ? formatDateTime(file.accessTime) : 'N/A';
    const ownerStr = file.owner || 'N/A';
    const groupStr = file.group || 'N/A';
    const permStr = file.permissions || 'N/A';
    this.tooltip = new vscode.MarkdownString(
      `**${file.name}**\n\n` +
        `- Path: \`${file.path}\`\n` +
        `- Size: ${sizeStr || 'Directory'}\n` +
        `- Modified: ${modifiedStr}\n` +
        `- Accessed: ${accessStr}\n` +
        `- Owner: ${ownerStr}:${groupStr}\n` +
        `- Permissions: \`${permStr}\``
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

/**
 * Tree item showing loading indicator with spinning icon
 */
export class LoadingTreeItem extends vscode.TreeItem {
  constructor(message: string = 'Loading...', uniqueKey?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    // Unique ID - use provided key or generate unique one to prevent ID conflicts
    this.id = uniqueKey ? `loading:${uniqueKey}` : `loading:${Date.now()}:${Math.random()}`;
    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'loading';
  }
}

/**
 * Tree item for filter results header
 */
export class FilterResultsHeaderItem extends vscode.TreeItem {
  constructor(
    public readonly connection: SSHConnection,
    public readonly resultCount: number,
    public readonly isSearching: boolean
  ) {
    super(
      isSearching ? 'Searching remote files...' : `Filter Results (${resultCount} files)`,
      resultCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `filter-header:${connection.id}`;
    this.contextValue = 'filterResultsHeader';
    this.iconPath = isSearching
      ? new vscode.ThemeIcon('sync~spin')
      : new vscode.ThemeIcon('filter-filled', new vscode.ThemeColor('charts.blue'));
    this.description = isSearching ? '' : 'from recursive search';
  }
}

/**
 * Tree item for a file found via deep filter (shows full path)
 */
export class FilteredFileItem extends vscode.TreeItem {
  constructor(
    public readonly file: IRemoteFile,
    public readonly connection: SSHConnection
  ) {
    super(file.name, vscode.TreeItemCollapsibleState.None);

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `filtered:${connection.id}:${file.path}`;
    this.resourceUri = vscode.Uri.parse(`ssh://${connection.id}${file.path}`);
    this.contextValue = 'file'; // Same context as regular file for menus

    // Show parent directory in description
    const parentDir = path.posix.dirname(file.path);
    this.description = parentDir;

    this.iconPath = vscode.ThemeIcon.File;

    // Tooltip with full path, times, owner, and permissions
    const sizeStr = formatFileSize(file.size);
    const modifiedStr = formatDateTime(file.modifiedTime);
    const accessStr = file.accessTime ? formatDateTime(file.accessTime) : 'N/A';
    const ownerStr = file.owner || 'N/A';
    const groupStr = file.group || 'N/A';
    const permStr = file.permissions || 'N/A';
    this.tooltip = new vscode.MarkdownString(
      `**${file.name}**\n\n` +
        `- Path: \`${file.path}\`\n` +
        `- Size: ${sizeStr}\n` +
        `- Modified: ${modifiedStr}\n` +
        `- Accessed: ${accessStr}\n` +
        `- Owner: ${ownerStr}:${groupStr}\n` +
        `- Permissions: \`${permStr}\``
    );

    // Click to open file
    this.command = {
      command: 'sshLite.openFile',
      title: 'Open File',
      arguments: [this],
    };
  }
}

type TreeItem = ConnectionTreeItem | FileTreeItem | ParentFolderTreeItem | FilterResultsHeaderItem | FilteredFileItem | LoadingTreeItem;

/**
 * MIME type for drag and drop of connections
 */
const CONNECTION_MIME_TYPE = 'application/vnd.code.tree.sshlite.connection';

/**
 * Tree data provider for remote file explorer with drag-drop support
 */
export class FileTreeProvider implements vscode.TreeDataProvider<TreeItem>, vscode.TreeDragAndDropController<TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Drag and drop configuration
  readonly dropMimeTypes = [CONNECTION_MIME_TYPE];
  readonly dragMimeTypes = [CONNECTION_MIME_TYPE];

  private connectionManager: ConnectionManager;
  private folderHistoryService: FolderHistoryService;
  private fileService: FileService;
  private currentPaths: Map<string, string> = new Map(); // connectionId -> current path
  private connectionOrder: string[] = []; // Custom order of connection IDs
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

  // Concurrency control for preloading
  private activePreloadCount: number = 0;
  private preloadWaitQueue: Array<() => void> = [];
  private preloadCancelled: boolean = false;
  private totalPreloadQueued: number = 0;
  private completedPreloadCount: number = 0;
  private preloadProgressResolve: (() => void) | null = null;
  private preloadSlotLock: Promise<void> = Promise.resolve(); // Mutex for slot acquisition

  // Filter pattern for file tree (glob-like pattern)
  private filterPattern: string = '';

  // Deep filter results from remote server search
  private deepFilterResults: Map<string, IRemoteFile[]> = new Map(); // connectionId -> matched files
  private isDeepFiltering: boolean = false;
  private deepFilterAbortController: AbortController | null = null;

  // Track items currently being loaded (for showing loading spinner)
  private loadingItems: Set<string> = new Set(); // Set of "connectionId:path" keys

  // Filename filter for tree highlighting (different from filterPattern which filters the view)
  private filenameFilterPattern: string = '';
  private filenameFilterBasePath: string = '';
  private filenameFilterConnectionId: string = '';
  private highlightedPaths: Set<string> = new Set();

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();
    this.folderHistoryService = FolderHistoryService.getInstance();
    this.fileService = FileService.getInstance();

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
   * Load directory in background and refresh tree item when done
   * This allows showing a loading placeholder immediately while loading
   */
  private loadDirectoryAndRefresh(
    connection: SSHConnection,
    remotePath: string,
    element: TreeItem
  ): void {
    const loadingKey = this.getCacheKey(connection.id, remotePath);

    this.loadDirectory(connection, remotePath, false)
      .then(() => {
        // Loading complete, remove from loading set and refresh
        this.loadingItems.delete(loadingKey);
        this._onDidChangeTreeData.fire(element);
      })
      .catch((error) => {
        // Loading failed, remove from loading set
        this.loadingItems.delete(loadingKey);
        this._onDidChangeTreeData.fire(element);
        vscode.window.showErrorMessage(`Failed to list directory: ${(error as Error).message}`);
      });
  }

  /**
   * Get cache key for a connection and path
   */
  private getCacheKey(connectionId: string, remotePath: string): string {
    return `${connectionId}:${remotePath}`;
  }

  /**
   * Get cached directory listing
   * Cache persists until disconnect (no TTL) for session-based caching
   */
  private getCached(connectionId: string, remotePath: string): IRemoteFile[] | null {
    const key = this.getCacheKey(connectionId, remotePath);
    const entry = this.directoryCache.get(key);
    if (entry) {
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
   * Also clears deep filter results for the connection
   */
  clearCache(connectionId?: string): void {
    if (connectionId) {
      const prefix = `${connectionId}:`;
      for (const key of this.directoryCache.keys()) {
        if (key.startsWith(prefix)) {
          this.directoryCache.delete(key);
        }
      }
      this.deepFilterResults.delete(connectionId);
    } else {
      this.directoryCache.clear();
      this.deepFilterResults.clear();
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
   * Check if preloading is enabled
   */
  private isPreloadingEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('sshLite');
    return config.get<boolean>('enablePreloading', true);
  }

  /**
   * Get max preloading concurrency from settings
   */
  private getMaxPreloadingConcurrency(): number {
    const config = vscode.workspace.getConfiguration('sshLite');
    return config.get<number>('maxPreloadingConcurrency', 2);
  }

  /**
   * Acquire a preload slot (for concurrency limiting)
   * Returns a release function that must be called when done
   * Uses a mutex to prevent race conditions in slot acquisition
   */
  private async acquirePreloadSlot(): Promise<() => void> {
    // Acquire lock to ensure atomic check-and-increment
    const previousLock = this.preloadSlotLock;
    let releaseLockFn: () => void;
    this.preloadSlotLock = new Promise<void>((resolve) => {
      releaseLockFn = resolve;
    });

    await previousLock;

    const maxConcurrency = this.getMaxPreloadingConcurrency();

    if (this.activePreloadCount < maxConcurrency) {
      this.activePreloadCount++;
      releaseLockFn!(); // Release lock immediately since we got a slot
      return () => this.releasePreloadSlot();
    }

    // Release lock before waiting (allow others to queue up)
    releaseLockFn!();

    // Wait for a slot to become available
    await new Promise<void>((resolve) => {
      this.preloadWaitQueue.push(resolve);
    });

    // Re-acquire lock for increment
    const prevLock2 = this.preloadSlotLock;
    let releaseLock2: () => void;
    this.preloadSlotLock = new Promise<void>((resolve) => {
      releaseLock2 = resolve;
    });
    await prevLock2;

    this.activePreloadCount++;
    releaseLock2!();

    return () => this.releasePreloadSlot();
  }

  /**
   * Release a preload slot
   * Uses async lock to ensure atomic decrement and queue notification
   */
  private async releasePreloadSlot(): Promise<void> {
    // Acquire lock for atomic decrement
    const previousLock = this.preloadSlotLock;
    let releaseLockFn: () => void;
    this.preloadSlotLock = new Promise<void>((resolve) => {
      releaseLockFn = resolve;
    });

    await previousLock;

    this.activePreloadCount--;

    // Wake up next waiting preload if any
    if (this.preloadWaitQueue.length > 0) {
      const next = this.preloadWaitQueue.shift();
      if (next) {
        next();
      }
    }

    releaseLockFn!();
  }

  /**
   * Preload subdirectories in background (non-blocking)
   * Respects maxPreloadingConcurrency setting to limit server load
   * Called after user expands a folder - resets cancelled flag for user-initiated actions
   */
  private preloadSubdirectories(connection: SSHConnection, files: IRemoteFile[]): void {
    // Skip preloading if disabled
    if (!this.isPreloadingEnabled()) {
      return;
    }

    // User expanded a folder - reset cancelled flag so preloading can continue
    // This is a user-initiated action, not background preloading
    if (this.preloadCancelled && this.preloadQueue.size === 0 && this.activePreloadCount === 0) {
      this.preloadCancelled = false;
    }

    // Get all directories
    const allDirectories = files.filter((f) => f.isDirectory);
    if (allDirectories.length === 0) return;

    // Get frequently visited folders for this connection
    const frequentFolders = new Set(this.folderHistoryService.getFrequentFolders(connection.id, 20));

    // Sort directories: frequently visited first, then alphabetically
    const sortedDirectories = [...allDirectories].sort((a, b) => {
      const aFrequent = frequentFolders.has(a.path);
      const bFrequent = frequentFolders.has(b.path);
      if (aFrequent && !bFrequent) return -1;
      if (!aFrequent && bFrequent) return 1;
      return a.name.localeCompare(b.name);
    });

    // Take top 5 (prioritized by frequency)
    const directories = sortedDirectories.slice(0, 5);

    // Reset cancelled flag if starting fresh preload
    if (this.preloadQueue.size === 0 && this.activePreloadCount === 0) {
      this.preloadCancelled = false;
      this.completedPreloadCount = 0;
      this.totalPreloadQueued = 0;
    }

    // Preload with concurrency control
    for (const dir of directories) {
      const cacheKey = this.getCacheKey(connection.id, dir.path);

      // Skip if already cached or being loaded or in preload queue
      if (this.getCached(connection.id, dir.path) ||
          this.activeLoads.has(cacheKey) ||
          this.preloadQueue.has(cacheKey)) {
        continue;
      }

      this.preloadQueue.add(cacheKey);
      this.totalPreloadQueued++;

      // Preload with concurrency limiting - give extra depth to frequent folders
      const isFrequent = frequentFolders.has(dir.path);
      this.preloadWithConcurrencyLimit(connection, dir.path, cacheKey, isFrequent ? 2 : 1);
    }
  }

  /**
   * Preload a directory with concurrency limiting
   * @param depth - How many more levels to preload (0 = just this directory)
   */
  private async preloadWithConcurrencyLimit(
    connection: SSHConnection,
    dirPath: string,
    cacheKey: string,
    depth: number = 1
  ): Promise<void> {
    // Check if cancelled before acquiring slot
    if (this.preloadCancelled) {
      this.preloadQueue.delete(cacheKey);
      return;
    }

    const releaseSlot = await this.acquirePreloadSlot();

    try {
      // Check again after acquiring slot
      if (this.preloadCancelled) {
        return;
      }
      const files = await this.loadDirectory(connection, dirPath, true);

      // If we have remaining depth, queue subdirectories for preloading too
      if (depth > 0 && files && !this.preloadCancelled) {
        const subdirs = files.filter((f) => f.isDirectory).slice(0, 3); // Limit to 3 per level
        for (const subdir of subdirs) {
          const subCacheKey = this.getCacheKey(connection.id, subdir.path);
          if (!this.getCached(connection.id, subdir.path) &&
              !this.activeLoads.has(subCacheKey) &&
              !this.preloadQueue.has(subCacheKey)) {
            this.preloadQueue.add(subCacheKey);
            this.totalPreloadQueued++;
            // Queue with reduced depth
            this.preloadWithConcurrencyLimit(connection, subdir.path, subCacheKey, depth - 1);
          }
        }
      }
    } catch {
      /* Silently ignore preload errors */
    } finally {
      this.preloadQueue.delete(cacheKey);
      this.completedPreloadCount++;
      await releaseSlot();

      // Check if all preloads are done
      if (this.preloadQueue.size === 0 && this.preloadProgressResolve) {
        this.preloadProgressResolve();
        this.preloadProgressResolve = null;
      }
    }
  }

  /**
   * Cancel all pending preload operations
   */
  cancelPreloading(): void {
    this.preloadCancelled = true;

    // Wake up all waiting preloads so they can check cancellation
    while (this.preloadWaitQueue.length > 0) {
      const next = this.preloadWaitQueue.shift();
      if (next) {
        next();
      }
    }

    // Clear the queue
    this.preloadQueue.clear();

    // Resolve the progress if waiting
    if (this.preloadProgressResolve) {
      this.preloadProgressResolve();
      this.preloadProgressResolve = null;
    }
  }

  /**
   * Check if preloading is in progress
   */
  isPreloadingInProgress(): boolean {
    return this.preloadQueue.size > 0 || this.activePreloadCount > 0;
  }

  /**
   * Get preload status for UI display
   */
  getPreloadStatus(): { active: number; queued: number; completed: number; total: number } {
    return {
      active: this.activePreloadCount,
      queued: this.preloadQueue.size,
      completed: this.completedPreloadCount,
      total: this.totalPreloadQueued,
    };
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
   * Refresh a specific folder by path
   * Clears cache and triggers tree refresh
   */
  refreshFolder(connectionId: string, folderPath: string): void {
    // Clear cache for this folder
    const key = this.getCacheKey(connectionId, folderPath);
    this.directoryCache.delete(key);

    // Trigger full refresh since we need to update the tree
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set filter pattern for the file tree
   * Supports glob-like patterns: * (any chars), ? (single char)
   * Empty string clears the filter
   *
   * LITE PRINCIPLE: Filter only works on CACHED files (already loaded).
   * Does NOT automatically search the server - use searchServerForFilter() for that.
   */
  setFilter(pattern: string): void {
    // Cancel any existing deep filter search
    if (this.deepFilterAbortController) {
      this.deepFilterAbortController.abort();
      this.deepFilterAbortController = null;
    }

    this.filterPattern = pattern.toLowerCase();
    this.deepFilterResults.clear();
    this.isDeepFiltering = false;

    // LITE: Do NOT auto-search server. Only filter cached files.
    // User must explicitly trigger server search via searchServerForFilter()

    this.refresh();
  }

  /**
   * Get current filter pattern
   */
  getFilter(): string {
    return this.filterPattern;
  }

  /**
   * Clear the filter
   */
  clearFilter(): void {
    // Cancel any existing deep filter search
    if (this.deepFilterAbortController) {
      this.deepFilterAbortController.abort();
      this.deepFilterAbortController = null;
    }

    this.filterPattern = '';
    this.deepFilterResults.clear();
    this.isDeepFiltering = false;
    this.refresh();
  }

  /**
   * Check if a file matches the current filter pattern
   */
  private matchesFilter(file: IRemoteFile): boolean {
    if (!this.filterPattern) {
      return true; // No filter, show all
    }

    const fileName = file.name.toLowerCase();
    const pattern = this.filterPattern;

    // Always show directories when filtering (to allow navigation)
    if (file.isDirectory) {
      return true;
    }

    // Convert glob pattern to regex
    // * -> .* (any characters)
    // ? -> . (single character)
    // Escape other special regex characters
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*/g, '.*') // * -> .*
      .replace(/\?/g, '.'); // ? -> .

    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(fileName);
    } catch {
      // If regex is invalid, fall back to simple includes
      return fileName.includes(pattern);
    }
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
    // Root level: show all connections in custom order
    if (!element) {
      const connections = this.getOrderedConnections();

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
      const loadingKey = this.getCacheKey(element.connection.id, currentPath);

      // Check cache first - if cached, no loading indicator needed
      const cached = this.getCached(element.connection.id, currentPath);
      if (cached) {
        this.loadingItems.delete(loadingKey);
        const items = this.buildDirectoryItems(element.connection, currentPath, cached);
        // Preload subdirectories in background
        this.preloadSubdirectories(element.connection, cached);
        return items;
      }

      // If already loading, show loading placeholder
      if (this.loadingItems.has(loadingKey)) {
        return [new LoadingTreeItem('Loading...', loadingKey)];
      }

      // Start loading in background and return loading placeholder immediately
      this.loadingItems.add(loadingKey);
      this.loadDirectoryAndRefresh(element.connection, currentPath, element);
      return [new LoadingTreeItem('Loading...', loadingKey)];
    }

    // Filter results header: show deep filter results
    if (element instanceof FilterResultsHeaderItem) {
      const results = this.deepFilterResults.get(element.connection.id) || [];
      return results.map((file) => new FilteredFileItem(file, element.connection));
    }

    // File level: show directory contents
    if (element instanceof FileTreeItem && element.file.isDirectory) {
      const loadingKey = this.getCacheKey(element.connection.id, element.file.path);

      // Check cache first
      const cached = this.getCached(element.connection.id, element.file.path);
      if (cached) {
        this.loadingItems.delete(loadingKey);
        // Apply filter
        const filteredFiles = cached.filter((file) => this.matchesFilter(file));
        const items = filteredFiles.map((file) => new FileTreeItem(
          file,
          element.connection,
          this.highlightedPaths.has(file.path)
        ));
        // Preload subdirectories in background
        this.preloadSubdirectories(element.connection, cached);
        return items;
      }

      // If already loading, show loading placeholder
      if (this.loadingItems.has(loadingKey)) {
        return [new LoadingTreeItem('Loading...', loadingKey)];
      }

      // Start loading in background and return loading placeholder immediately
      this.loadingItems.add(loadingKey);
      this.loadDirectoryAndRefresh(element.connection, element.file.path, element);
      return [new LoadingTreeItem('Loading...', loadingKey)];
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
      // Preload parent folder for instant navigation
      this.preloadParentFolder(connection, parentPath || '/');
    } else if (currentPath === '~') {
      // Allow going to root from home
      items.push(new ParentFolderTreeItem(connection, '/'));
      // Preload root for instant navigation
      this.preloadParentFolder(connection, '/');
    }

    // Apply filter and add files with highlighting
    const filteredFiles = files.filter((file) => this.matchesFilter(file));
    items.push(...filteredFiles.map((file) => new FileTreeItem(
      file,
      connection,
      this.highlightedPaths.has(file.path)
    )));

    // Add filter results section if filter is active
    if (this.filterPattern) {
      const deepResults = this.deepFilterResults.get(connection.id) || [];
      const isSearching = this.isDeepFiltering;

      // Only show if searching or has results
      if (isSearching || deepResults.length > 0) {
        items.push(new FilterResultsHeaderItem(connection, deepResults.length, isSearching));
      }
    }

    return items;
  }

  /**
   * Preload parent folder for instant "go up" navigation
   * NOTE: Parent folder is ALWAYS preloaded (not controlled by enablePreloading setting)
   * because it's essential for basic navigation - users expect instant "go to parent"
   * Also NOT affected by preloadCancelled - user navigation should never be blocked
   * Respects maxPreloadingConcurrency setting to limit server load
   */
  private preloadParentFolder(connection: SSHConnection, parentPath: string): void {
    // Parent folder preloading is NEVER blocked - essential for navigation
    // Don't check preloadCancelled here - user expects instant "go to parent"

    const cacheKey = this.getCacheKey(connection.id, parentPath);

    // Skip if already cached, loading, or in preload queue
    if (
      this.getCached(connection.id, parentPath) ||
      this.activeLoads.has(cacheKey) ||
      this.preloadQueue.has(cacheKey)
    ) {
      return;
    }

    this.preloadQueue.add(cacheKey);
    this.totalPreloadQueued++;

    // Preload with concurrency limiting
    this.preloadWithConcurrencyLimit(connection, parentPath, cacheKey);
  }

  /**
   * Preload current directories for all connections in parallel
   * LITE PRINCIPLE: Most preloading only runs if enablePreloading is true
   * Exception: Current directory is always loaded (required for tree view)
   */
  private preloadConnectionDirectories(connections: SSHConnection[]): void {
    const preloadingEnabled = this.isPreloadingEnabled();

    for (const conn of connections) {
      const currentPath = this.getCurrentPath(conn.id);

      // REQUIRED: Always load the current directory (needed for tree view)
      // This is NOT preloading - it's the actual content being displayed
      if (!this.getCached(conn.id, currentPath)) {
        this.loadDirectory(conn, currentPath, true).catch(() => {
          /* Silently ignore errors */
        });
      }

      // ALWAYS preload parent folder for instant "go up" navigation (LITE exception)
      // This is essential for basic navigation - users expect instant "go to parent"
      if (currentPath !== '/' && currentPath !== '~') {
        const parentPath = path.posix.dirname(currentPath);
        this.preloadParentFolder(conn, parentPath || '/');
      } else if (currentPath === '~') {
        // Preload root when at home
        this.preloadParentFolder(conn, '/');
      }

      // LITE: Everything below only runs if preloading is enabled
      if (!preloadingEnabled) {
        continue;
      }

      // Preload home directory if different from current
      if (currentPath !== '~' && !this.getCached(conn.id, '~')) {
        this.loadDirectory(conn, '~', true).catch(() => {
          /* Silently ignore preload errors */
        });
      }

      // Preload frequently used folders from history (top 5)
      this.preloadFrequentFolders(conn);

      // Preload frequently opened files (top 5)
      this.fileService.preloadFrequentFiles(conn, 5).catch(() => {
        /* Silently ignore preload errors */
      });
    }
  }

  /**
   * Preload frequently used folders from history
   * Respects maxPreloadingConcurrency setting to limit server load
   */
  private preloadFrequentFolders(connection: SSHConnection): void {
    // Note: Caller should check isPreloadingEnabled() before calling
    if (this.preloadCancelled) {
      return;
    }

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
      this.totalPreloadQueued++;

      // Preload with concurrency limiting
      this.preloadWithConcurrencyLimit(connection, folderPath, cacheKey);
    }
  }

  /**
   * Get parent element
   * This is critical for VS Code's tree virtualization - must return correct parent
   * so items are rendered at the correct indentation level when scrolling
   */
  getParent(element: TreeItem): vscode.ProviderResult<TreeItem> {
    if (element instanceof FileTreeItem) {
      const parentPath = path.posix.dirname(element.file.path);
      const currentPath = this.getCurrentPath(element.connection.id);

      // If parent path is the current root path, return the connection
      if (parentPath === currentPath || parentPath === element.file.path || parentPath === '.') {
        return new ConnectionTreeItem(element.connection, currentPath);
      }

      // If parent is the filesystem root, return connection
      if (parentPath === '/') {
        return new ConnectionTreeItem(element.connection, currentPath);
      }

      // For nested directories, return a FileTreeItem representing the parent directory
      // We need to construct the parent's IRemoteFile from the path
      const parentName = path.posix.basename(parentPath);
      const parentFile: IRemoteFile = {
        name: parentName,
        path: parentPath,
        isDirectory: true,
        size: 0,
        modifiedTime: 0,
        connectionId: element.connection.id,
      };
      return new FileTreeItem(parentFile, element.connection);
    }

    if (element instanceof ParentFolderTreeItem) {
      // Parent folder items are children of the connection
      const currentPath = this.getCurrentPath(element.connection.id);
      return new ConnectionTreeItem(element.connection, currentPath);
    }

    // ConnectionTreeItem has no parent (root level)
    return undefined;
  }

  /**
   * Handle drag start - only allow dragging connection items
   */
  handleDrag(
    source: readonly TreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    // Only allow dragging connection items
    const connectionItems = source.filter((item) => item instanceof ConnectionTreeItem);
    if (connectionItems.length === 0) {
      return;
    }

    // Store connection IDs in the data transfer
    const connectionIds = connectionItems.map((item) => (item as ConnectionTreeItem).connection.id);
    dataTransfer.set(CONNECTION_MIME_TYPE, new vscode.DataTransferItem(connectionIds));
  }

  /**
   * Handle drop - reorder connections
   */
  handleDrop(
    target: TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    const transferItem = dataTransfer.get(CONNECTION_MIME_TYPE);
    if (!transferItem) {
      return;
    }

    const draggedConnectionIds: string[] = transferItem.value;
    if (!draggedConnectionIds || draggedConnectionIds.length === 0) {
      return;
    }

    // Get current connections to build order
    const connections = this.connectionManager.getAllConnections();
    const currentIds = connections.map((c) => c.id);

    // Determine target position
    let targetIndex: number;
    if (!target) {
      // Dropped on empty space - move to end
      targetIndex = currentIds.length;
    } else if (target instanceof ConnectionTreeItem) {
      // Dropped on another connection - insert before it
      targetIndex = this.connectionOrder.indexOf(target.connection.id);
      if (targetIndex === -1) {
        targetIndex = currentIds.indexOf(target.connection.id);
      }
    } else {
      // Dropped on a file/folder - find parent connection
      if (target instanceof FileTreeItem || target instanceof ParentFolderTreeItem) {
        const parentConnectionId = target.connection.id;
        targetIndex = this.connectionOrder.indexOf(parentConnectionId);
        if (targetIndex === -1) {
          targetIndex = currentIds.indexOf(parentConnectionId);
        }
      } else {
        return;
      }
    }

    // Build new order
    // First, ensure connectionOrder has all current connections
    this.syncConnectionOrder();

    // Remove dragged items from current order
    const newOrder = this.connectionOrder.filter((id) => !draggedConnectionIds.includes(id));

    // Adjust target index if items were removed before it
    let adjustedIndex = targetIndex;
    for (const draggedId of draggedConnectionIds) {
      const originalIndex = this.connectionOrder.indexOf(draggedId);
      if (originalIndex !== -1 && originalIndex < targetIndex) {
        adjustedIndex--;
      }
    }

    // Insert dragged items at new position
    newOrder.splice(Math.max(0, adjustedIndex), 0, ...draggedConnectionIds);

    // Update order and refresh
    this.connectionOrder = newOrder;
    this.refresh();
  }

  /**
   * Sync connection order with actual connections
   * Adds new connections and removes disconnected ones
   */
  private syncConnectionOrder(): void {
    const connections = this.connectionManager.getAllConnections();
    const currentIds = new Set(connections.map((c) => c.id));

    // Remove disconnected connections from order
    this.connectionOrder = this.connectionOrder.filter((id) => currentIds.has(id));

    // Add new connections that aren't in order yet (at the end)
    for (const conn of connections) {
      if (!this.connectionOrder.includes(conn.id)) {
        this.connectionOrder.push(conn.id);
      }
    }
  }

  /**
   * Get connections in custom order
   */
  private getOrderedConnections(): SSHConnection[] {
    this.syncConnectionOrder();
    const connections = this.connectionManager.getAllConnections();
    const connectionMap = new Map(connections.map((c) => [c.id, c]));

    // Return connections in custom order
    return this.connectionOrder
      .map((id) => connectionMap.get(id))
      .filter((c): c is SSHConnection => c !== undefined);
  }

  /**
   * Manually trigger server search for current filter pattern
   * LITE PRINCIPLE: This is user-triggered, not automatic
   * Call this when user clicks "Search Server" button
   */
  async searchServerForFilter(): Promise<void> {
    if (!this.filterPattern) {
      return; // No filter set
    }
    await this.startDeepFilter(this.filterPattern);
  }

  /**
   * Start deep filter search on all connections
   * Uses 'find' command to recursively search for matching files
   * LITE PRINCIPLE: Only called when user explicitly requests server search
   */
  private async startDeepFilter(pattern: string): Promise<void> {
    this.isDeepFiltering = true;
    this.deepFilterAbortController = new AbortController();
    const signal = this.deepFilterAbortController.signal;

    // Refresh to show "Searching..." indicator
    this._onDidChangeTreeData.fire();

    const connections = this.connectionManager.getAllConnections();

    // Search each connection in parallel
    const searchPromises = connections.map(async (connection) => {
      try {
        const currentPath = this.getCurrentPath(connection.id);

        // Convert glob pattern to find pattern
        // For find, we use -iname (case insensitive) with the pattern
        const findPattern = pattern.includes('*') || pattern.includes('?')
          ? pattern
          : `*${pattern}*`; // If no wildcards, wrap with wildcards

        // Execute find command on remote server
        const results = await connection.searchFiles(currentPath, pattern, {
          searchContent: false, // Filename search
          caseSensitive: false,
          maxResults: 200, // Limit results
        });

        if (signal.aborted) return;

        // Convert search results to IRemoteFile format
        const files: IRemoteFile[] = results.map((r) => ({
          name: path.posix.basename(r.path),
          path: r.path,
          isDirectory: false,
          size: 0,
          modifiedTime: Date.now(),
          connectionId: connection.id,
        }));

        // Filter out files that are already visible in the current tree view
        // (we only want to show files from deeper directories)
        const cachedPaths = new Set<string>();
        for (const [key, entry] of this.directoryCache) {
          if (key.startsWith(connection.id + ':')) {
            for (const file of entry.files) {
              cachedPaths.add(file.path);
            }
          }
        }

        const newFiles = files.filter((f) => !cachedPaths.has(f.path));

        if (newFiles.length > 0) {
          this.deepFilterResults.set(connection.id, newFiles);
        }
      } catch {
        // Silently ignore errors during deep filter
      }
    });

    await Promise.all(searchPromises);

    if (!signal.aborted) {
      this.isDeepFiltering = false;
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Check if deep filter is currently running
   */
  isDeepFilterActive(): boolean {
    return this.isDeepFiltering;
  }

  /**
   * Get deep filter results for a connection
   */
  getDeepFilterResults(connectionId: string): IRemoteFile[] {
    return this.deepFilterResults.get(connectionId) || [];
  }

  /**
   * Create a FileTreeItem for a given connection and remote path
   * Used for revealing files in the tree view
   */
  createFileTreeItem(connectionId: string, remotePath: string): FileTreeItem | undefined {
    const connection = this.connectionManager.getConnection(connectionId);
    if (!connection) {
      return undefined;
    }

    const fileName = path.posix.basename(remotePath);
    const file: IRemoteFile = {
      name: fileName,
      path: remotePath,
      isDirectory: false,
      size: 0,
      modifiedTime: Date.now(),
      connectionId: connectionId,
    };

    return new FileTreeItem(file, connection);
  }

  /**
   * Navigate to and reveal a file in the tree
   * First navigates to the parent folder, then refreshes and reveals the file
   */
  async revealFile(connectionId: string, remotePath: string): Promise<FileTreeItem | undefined> {
    const connection = this.connectionManager.getConnection(connectionId);
    if (!connection) {
      vscode.window.showWarningMessage('Connection not found');
      return undefined;
    }

    // Navigate to the parent folder
    const parentPath = path.posix.dirname(remotePath);
    this.setCurrentPath(connection.id, parentPath);

    // Refresh the tree to load the parent directory
    await this.loadDirectory(connection, parentPath, true);
    this._onDidChangeTreeData.fire();

    // Create and return the FileTreeItem for reveal
    return this.createFileTreeItem(connectionId, remotePath);
  }

  /**
   * Set filename filter for tree highlighting
   * This highlights matching files in the tree without filtering them out
   * @param pattern - Glob-like pattern (e.g., "*.ts", "config*")
   * @param basePath - The folder path to search within
   * @param connection - The SSH connection to search on
   */
  async setFilenameFilter(pattern: string, basePath: string, connection: SSHConnection): Promise<void> {
    this.filenameFilterPattern = pattern.toLowerCase();
    this.filenameFilterBasePath = basePath;
    this.filenameFilterConnectionId = connection.id;
    this.highlightedPaths.clear();

    if (!pattern) {
      this._onDidChangeTreeData.fire();
      return;
    }

    // Show loading status
    this.showLoading(`Finding files matching "${pattern}"...`);

    try {
      // Search for files matching the pattern
      const results = await connection.searchFiles(basePath, pattern, {
        searchContent: false, // Filename search only
        caseSensitive: false,
        maxResults: 500,
      });

      // Add all matching paths to highlighted set
      for (const result of results) {
        this.highlightedPaths.add(result.path);
        // Also highlight parent directories leading to the file
        let parentPath = path.posix.dirname(result.path);
        while (parentPath && parentPath !== '/' && parentPath !== basePath) {
          this.highlightedPaths.add(parentPath);
          parentPath = path.posix.dirname(parentPath);
        }
      }

      this.showSuccess(`Found ${results.length} files matching "${pattern}"`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to search files: ${(error as Error).message}`);
      this.hideLoading();
    }

    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear the filename filter and remove all highlights
   */
  clearFilenameFilter(): void {
    this.filenameFilterPattern = '';
    this.filenameFilterBasePath = '';
    this.filenameFilterConnectionId = '';
    this.highlightedPaths.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Check if a file path is highlighted by the filename filter
   */
  isHighlighted(filePath: string): boolean {
    return this.highlightedPaths.has(filePath);
  }

  /**
   * Check if filename filter is active
   */
  hasFilenameFilter(): boolean {
    return this.filenameFilterPattern.length > 0;
  }

  /**
   * Get current filename filter pattern
   */
  getFilenameFilterPattern(): string {
    return this.filenameFilterPattern;
  }

  /**
   * Get the base path for the filename filter
   */
  getFilenameFilterBasePath(): string {
    return this.filenameFilterBasePath;
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
    this.loadingItems.clear();

    // Cancel any running deep filter
    if (this.deepFilterAbortController) {
      this.deepFilterAbortController.abort();
    }
    this.deepFilterResults.clear();
    this.highlightedPaths.clear();
  }
}
