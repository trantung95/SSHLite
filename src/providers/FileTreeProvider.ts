import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile, IHostConfig } from '../types';
import { formatFileSize, formatRelativeTime, formatDateTime } from '../utils/helpers';
import { FolderHistoryService } from '../services/FolderHistoryService';
import { FileService } from '../services/FileService';
import { PriorityQueueService, PreloadPriority } from '../services/PriorityQueueService';
import { ActivityService } from '../services/ActivityService';

// Get extension path for custom icons
let extensionPath: string = '';
export function setFileTreeExtensionPath(extPath: string): void {
  extensionPath = extPath;
}

/**
 * Filter mode: what to match against the pattern
 */
export type FilterMode = 'files' | 'folders' | 'both';

/**
 * Active filename filter state for a specific folder
 */
interface ActiveFilter {
  pattern: string;                      // lowercase
  basePath: string;
  connectionId: string;
  highlightedPaths: Set<string>;
  matchCounts: Map<string, number>;     // folderPath → recursive match count
  filterMode: FilterMode;
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
 * Tree item representing a reconnecting connection (connection lost, auto-reconnecting)
 */
export class ReconnectingConnectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly host: IHostConfig,
    public readonly currentPath: string = '~',
    public readonly attempts: number = 0
  ) {
    super(host.name, vscode.TreeItemCollapsibleState.Expanded);

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `connection:${connectionId}`;
    this.description = `${host.username}@${host.host} - Reconnecting (${attempts})...`;
    this.contextValue = 'reconnecting';
    // Use spinning sync icon to show reconnecting status
    this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    this.tooltip = new vscode.MarkdownString(
      `**${host.name}**\n\n` +
      `Connection lost. Auto-reconnecting...\n\n` +
      `- Attempts: ${attempts}\n` +
      `- User: ${host.username}@${host.host}:${host.port}\n\n` +
      `_Tree data preserved from cache_`
    );
  }
}

/**
 * Tree item for navigating to parent directory
 * Uses highlighted styling to make it visually prominent (high priority action)
 */
export class ParentFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connection: SSHConnection,
    public readonly parentPath: string,
    public readonly currentPath: string = parentPath
  ) {
    super('..', vscode.TreeItemCollapsibleState.None);

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `parent:${connection.id}:${parentPath}`;
    this.description = 'Go to parent folder';
    this.contextValue = 'parentFolder';
    // Use arrow-up icon with charts.yellow color for high visibility (priority #1 action)
    this.iconPath = new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.yellow'));
    this.tooltip = new vscode.MarkdownString('**⬆️ Go to parent folder**\n\n`' + parentPath + '`');
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
    public readonly isHighlighted: boolean = false,
    public readonly isOpenInTab: boolean = false,
    public readonly isLoading: boolean = false,
    public readonly shouldBeExpanded: boolean = false,
    public readonly isFiltered: boolean = false,
    public readonly filterPattern: string = '',
    public readonly isEmptyAfterFilter: boolean = false,
    public readonly matchCount: number = 0
  ) {
    super(
      file.name,
      file.isDirectory
        ? (shouldBeExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None
    );

    // Unique ID for VS Code to preserve expand/collapse state
    this.id = `file:${connection.id}:${file.path}`;
    this.resourceUri = vscode.Uri.parse(`ssh://${connection.id}${file.path}`);
    this.contextValue = file.isDirectory
      ? (isFiltered ? 'folder.filtered' : 'folder')
      : 'file';

    // Set icon based on type, with special indicators for open/loading files
    if (file.isDirectory) {
      if (isEmptyAfterFilter) {
        this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('disabledForeground'));
      } else if (isHighlighted) {
        this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
      } else {
        this.iconPath = vscode.ThemeIcon.Folder;
      }
    } else if (isLoading) {
      // Show spinning icon when loading data from server
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (isOpenInTab) {
      // Show eye icon with green color for files open in editor tabs
      this.iconPath = new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.green'));
    } else if (isHighlighted) {
      this.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.yellow'));
    } else if (isEmptyAfterFilter) {
      this.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor('disabledForeground'));
    } else {
      this.iconPath = vscode.ThemeIcon.File;
    }

    // Format description: size + relative modified time (grayed out by VS Code)
    // Note: VS Code tree item descriptions don't render codicons, so we only use text
    // The icon itself already indicates open/loading state
    const sizeStr = file.isDirectory ? '' : formatFileSize(file.size);
    const timeStr = formatRelativeTime(file.modifiedTime);
    if (isFiltered && filterPattern) {
      // Show filter pattern + match count in description for filtered folders
      this.description = matchCount > 0 ? `[filter: ${filterPattern}] (${matchCount})` : `[filter: ${filterPattern}]`;
    } else if (file.isDirectory && matchCount > 0) {
      // Show match count for folders with matches from an active filter
      this.description = `${timeStr}  (${matchCount})`;
    } else {
      this.description = file.isDirectory
        ? timeStr
        : `${sizeStr}  ${timeStr}`;
    }

    // Tooltip with more details including times, owner, and permissions
    const modifiedStr = formatDateTime(file.modifiedTime);
    const accessStr = file.accessTime ? formatDateTime(file.accessTime) : 'N/A';
    const ownerStr = file.owner || 'N/A';
    const groupStr = file.group || 'N/A';
    const permStr = file.permissions || 'N/A';
    const openStr = isOpenInTab ? '**Open in Editor**\n\n' : '';
    const loadingStr = isLoading ? '**Loading from server...**\n\n' : '';
    this.tooltip = new vscode.MarkdownString(
      loadingStr + openStr +
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

type TreeItem = ConnectionTreeItem | ReconnectingConnectionTreeItem | FileTreeItem | ParentFolderTreeItem | FilterResultsHeaderItem | FilteredFileItem | LoadingTreeItem;

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
  private priorityQueue: PriorityQueueService;
  private currentPaths: Map<string, string> = new Map(); // connectionId -> current path
  private connectionOrder: string[] = []; // Custom order of connection IDs
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private isRefreshing: boolean = false; // Prevent overlapping auto-refresh
  private configChangeListener: vscode.Disposable;

  // Custom status bar item for loading indicator
  private loadingStatusBar: vscode.StatusBarItem;

  // Directory cache: connectionId:path -> CacheEntry
  private directoryCache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 30000; // 30 seconds cache TTL

  // Track active loading operations to avoid duplicates
  private activeLoads: Map<string, Promise<IRemoteFile[]>> = new Map();

  // Track pending preload operations (for deduplication - keys only)
  private preloadQueue: Set<string> = new Set();

  // Filter pattern for file tree (glob-like pattern)
  private filterPattern: string = '';

  // Deep filter results from remote server search
  private deepFilterResults: Map<string, IRemoteFile[]> = new Map(); // connectionId -> matched files
  private isDeepFiltering: boolean = false;
  private deepFilterAbortController: AbortController | null = null;

  // Track items currently being loaded (for showing loading spinner)
  private loadingItems: Set<string> = new Set(); // Set of "connectionId:path" keys

  // Filename filters for tree highlighting (multiple simultaneous filters supported)
  // Key: "connectionId:basePath"
  private activeFilters: Map<string, ActiveFilter> = new Map();
  private onFilterClearedCallback?: () => void;

  // Live update tracking: files currently open in editor tabs (show eye icon)
  private openFilePaths: Set<string> = new Set();

  // Loading state tracking: files currently being loaded/refreshed from server
  private loadingFilePaths: Set<string> = new Set();

  // Track expanded folders to restore expansion state
  // Key format: "connectionId:path"
  private expandedFolders: Set<string> = new Set();

  // Store last-created ConnectionTreeItem references for targeted refreshes
  // This avoids full tree refresh when only one connection changes (e.g., navigation)
  private connectionTreeItemRefs: Map<string, ConnectionTreeItem | ReconnectingConnectionTreeItem> = new Map();

  // Pending auto-expand paths: consumed once during getChildren, then cleared
  // Used by "Show tree from root" and reveal to auto-expand folders after navigation
  private pendingAutoExpandPaths: Map<string, Set<string>> = new Map(); // connectionId -> paths to auto-expand

  // Debounce timer for connection change events to prevent multiple rapid refreshes
  // This fixes tree state reset issues when disconnect fires multiple events
  private connectionChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly CONNECTION_CHANGE_DEBOUNCE_MS = 50;

  // Track known connection IDs to detect structural changes (add/remove) vs state changes
  private lastKnownConnectionIds: Set<string> = new Set();

  constructor() {
    this.connectionManager = ConnectionManager.getInstance();
    this.folderHistoryService = FolderHistoryService.getInstance();
    this.fileService = FileService.getInstance();
    this.priorityQueue = PriorityQueueService.getInstance();

    // Create custom status bar item (priority 100 = high, aligned left)
    this.loadingStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.loadingStatusBar.name = 'SSH Lite Loading';

    // Refresh when connections change (debounced to prevent multiple rapid refreshes)
    // During disconnect, multiple events fire in quick succession which can confuse
    // VS Code's tree expansion state tracking. Debouncing consolidates these into one refresh.
    this.connectionManager.onDidChangeConnections(() => {
      this.debouncedConnectionRefresh();
    });

    // Start auto-refresh timer if configured
    this.startAutoRefresh();

    // Listen for configuration changes
    this.configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshLite.treeRefreshIntervalSeconds')) {
        this.restartAutoRefresh();
      }
    });

    // Subscribe to open files changes (for live-update eye icon on all open tab files)
    // NOTE: We only update state tracking here - NO full tree refresh
    // Full tree refreshes on every tab switch cause expansion state loss for multi-server trees.
    // The eye icon will appear when VS Code re-renders the item (on scroll, expand, or next refresh)
    this.fileService.onOpenFilesChanged((openFiles) => {
      this.openFilePaths = openFiles;
      // Do NOT refresh tree - full refresh causes expansion state loss across multiple connections
      // The correct icon will show on next natural tree render
    });

    // Subscribe to file loading changes (for spinner indicators)
    // NOTE: We only update state tracking here - NO tree refresh
    // This preserves tooltips. The spinner icon will appear when VS Code
    // re-renders the item (on scroll, expand, or next manual refresh)
    this.fileService.onFileLoadingChanged(({ remotePath, isLoading }) => {
      if (isLoading) {
        this.loadingFilePaths.add(remotePath);
      } else {
        this.loadingFilePaths.delete(remotePath);
      }
      // Do NOT refresh tree - this preserves tooltip state
      // The correct icon will show on next natural tree render
    });

    // Subscribe to reconnecting events (for auto-reconnect UI updates)
    // Also debounced to consolidate with connection change events
    this.connectionManager.onReconnecting(({ connectionId, isReconnecting }) => {
      // Refresh tree to show reconnecting status
      // Don't clear cache - we want to preserve the tree data
      this.debouncedConnectionRefresh();
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

    // Track activity via ActivityService
    const activityService = ActivityService.getInstance();
    const folderName = remotePath === '~' ? 'Home' : path.basename(remotePath) || '/';
    const activityId = activityService.startActivity(
      'directory-load',
      connection.id,
      connection.host.name,
      `List: ${folderName}`,
      { detail: remotePath }
    );

    this.loadDirectory(connection, remotePath, false)
      .then((files) => {
        // Complete activity tracking
        activityService.completeActivity(activityId, `${files.length} items`);
        // Loading complete, remove from loading set and refresh
        this.loadingItems.delete(loadingKey);
        this._onDidChangeTreeData.fire(element);
      })
      .catch((error) => {
        // Fail activity tracking
        activityService.failActivity(activityId, (error as Error).message);
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
   * Preload subdirectories in background (non-blocking)
   * Uses PriorityQueueService for priority-based scheduling
   * Called after user expands a folder
   */
  private preloadSubdirectories(connection: SSHConnection, files: IRemoteFile[]): void {
    // Skip preloading if disabled
    if (!this.isPreloadingEnabled()) {
      return;
    }

    // User expanded a folder - reset this connection's queue if it was cancelled
    if (this.priorityQueue.isConnectionCancelled(connection.id) && !this.priorityQueue.isPreloadingInProgress()) {
      this.priorityQueue.resetConnection(connection.id);
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

    if (directories.length > 0) {
      console.log(`[SSH Lite Preload] Queuing ${directories.length} subdirs for ${connection.host.name}`);
    }

    // Preload with priority queue
    for (const dir of directories) {
      const cacheKey = this.getCacheKey(connection.id, dir.path);

      // Skip if already cached or being loaded or in preload queue
      if (this.getCached(connection.id, dir.path) ||
          this.activeLoads.has(cacheKey) ||
          this.preloadQueue.has(cacheKey)) {
        continue;
      }

      this.preloadQueue.add(cacheKey);

      // Determine priority based on folder frequency
      // First-time subdirectory preload uses HIGH priority for fast initial loads
      // Frequent folders use MEDIUM priority since they're already known to be useful
      const isFrequent = frequentFolders.has(dir.path);
      const priority = isFrequent ? PreloadPriority.MEDIUM : PreloadPriority.HIGH;
      const depth = isFrequent ? 2 : 1;

      // Enqueue with priority
      this.enqueueDirectoryPreload(connection, dir.path, cacheKey, priority, depth);
    }
  }

  /**
   * Enqueue a directory preload task with priority
   * @param priority - Task priority level
   * @param depth - How many more levels to preload (0 = just this directory)
   */
  private enqueueDirectoryPreload(
    connection: SSHConnection,
    dirPath: string,
    cacheKey: string,
    priority: PreloadPriority,
    depth: number = 1
  ): void {
    this.priorityQueue.enqueue(
      connection.id,
      `Preload ${dirPath}`,
      priority,
      async () => {
        try {
          const files = await this.loadDirectory(connection, dirPath, true);
          console.log(`[SSH Lite Preload] Loaded ${dirPath} (${files?.length ?? 0} items) [${connection.host.name}]`);

          // If we have remaining depth, queue subdirectories for preloading too
          if (depth > 0 && files && !this.priorityQueue.isConnectionCancelled(connection.id)) {
            const subdirs = files.filter((f) => f.isDirectory).slice(0, 3); // Limit to 3 per level
            for (const subdir of subdirs) {
              const subCacheKey = this.getCacheKey(connection.id, subdir.path);
              if (!this.getCached(connection.id, subdir.path) &&
                  !this.activeLoads.has(subCacheKey) &&
                  !this.preloadQueue.has(subCacheKey)) {
                this.preloadQueue.add(subCacheKey);
                // Queue with reduced depth and lower priority
                const subPriority = priority < PreloadPriority.IDLE ? priority + 1 : PreloadPriority.IDLE;
                this.enqueueDirectoryPreload(connection, subdir.path, subCacheKey, subPriority as PreloadPriority, depth - 1);
              }
            }
          }
        } finally {
          this.preloadQueue.delete(cacheKey);
        }
      }
    ).catch((err) => {
      console.log(`[SSH Lite Preload] Failed ${dirPath}: ${(err as Error)?.message || 'unknown'}`);
      this.preloadQueue.delete(cacheKey);
    });
  }

  /**
   * Cancel all pending preload operations
   */
  cancelPreloading(): void {
    this.priorityQueue.cancelAll();

    // Clear the local tracking queue
    this.preloadQueue.clear();
  }

  /**
   * Check if preloading is in progress
   */
  isPreloadingInProgress(): boolean {
    return this.preloadQueue.size > 0 || this.priorityQueue.isPreloadingInProgress();
  }

  /**
   * Get preload status for UI display
   */
  getPreloadStatus(): { active: number; queued: number; completed: number; total: number; byPriority: { [key: number]: number } } {
    return this.priorityQueue.getStatus();
  }

  /**
   * Get current path for a connection
   */
  getCurrentPath(connectionId: string): string {
    return this.currentPaths.get(connectionId) || '~';
  }

  /**
   * Set current path for a connection and refresh
   * Uses targeted refresh for just the affected connection to preserve other connections' tree state
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

    // Use targeted refresh for just this connection to preserve other connections' tree state
    this.refreshConnection(connectionId);
  }

  /**
   * Refresh only a specific connection's tree items (preserves other connections' expansion state)
   * Falls back to full refresh if connection reference is not found
   */
  refreshConnection(connectionId: string): void {
    const connItem = this.connectionTreeItemRefs.get(connectionId);
    if (connItem) {
      // Update the description to show new path
      const currentPath = this.getCurrentPath(connectionId);
      if (connItem instanceof ConnectionTreeItem) {
        connItem.description = `${connItem.connection.host.username}@${connItem.connection.host.host} - ${currentPath}`;
      }
      // Targeted refresh - only this connection's children are re-fetched
      this._onDidChangeTreeData.fire(connItem);
    } else {
      // Fallback to full refresh if ref not available
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Set paths that should auto-expand on the next getChildren render.
   * These are consumed once (auto-expand fires, then paths are removed).
   * Also merges with currently expanded folders to preserve existing state.
   */
  setAutoExpandPaths(connectionId: string, expandPaths: Set<string>): void {
    // Merge with any existing pending paths
    const existing = this.pendingAutoExpandPaths.get(connectionId);
    if (existing) {
      for (const p of expandPaths) existing.add(p);
    } else {
      this.pendingAutoExpandPaths.set(connectionId, new Set(expandPaths));
    }
  }

  /**
   * Load all ancestor directories from root to targetPath into cache
   */
  async loadAncestorDirs(connection: SSHConnection, targetPath: string): Promise<void> {
    const segments = targetPath.split('/').filter(Boolean);
    let ancestorPath = '/';

    // Load root if not cached
    if (!this.getCached(connection.id, '/')) {
      await this.loadDirectory(connection, '/', true);
    }

    // Load each ancestor level
    for (const segment of segments) {
      ancestorPath = ancestorPath === '/' ? `/${segment}` : `${ancestorPath}/${segment}`;
      if (!this.getCached(connection.id, ancestorPath)) {
        try {
          await this.loadDirectory(connection, ancestorPath, true);
        } catch {
          // Stop loading if an ancestor fails (permission denied etc.)
          break;
        }
      }
    }
  }

  /**
   * Start the auto-refresh timer based on configuration
   */
  private startAutoRefresh(): void {
    const intervalSeconds = getRefreshInterval();
    if (intervalSeconds > 0) {
      const intervalMs = intervalSeconds * 1000;
      this.refreshTimer = setInterval(async () => {
        // Only refresh if there are active connections and not already refreshing
        const connections = this.connectionManager.getAllConnections();
        if (connections.length > 0 && !this.isRefreshing) {
          this.isRefreshing = true;
          try {
            // Refresh each connection individually to preserve expansion state
            for (const conn of connections) {
              this.refreshConnection(conn.id);
            }
          } finally {
            this.isRefreshing = false;
          }
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
   * Debounced refresh for connection change events
   * Consolidates multiple rapid events (like during disconnect) into a single refresh.
   * Uses targeted refresh when connections haven't structurally changed (no add/remove)
   * to preserve tree expansion state across all servers.
   */
  private debouncedConnectionRefresh(): void {
    if (this.connectionChangeDebounceTimer) {
      clearTimeout(this.connectionChangeDebounceTimer);
    }
    this.connectionChangeDebounceTimer = setTimeout(() => {
      this.connectionChangeDebounceTimer = null;

      // Check if connection list structurally changed (add/remove)
      const { active, reconnecting } = this.connectionManager.getAllConnectionsWithReconnecting();
      const currentIds = new Set([
        ...active.map(c => c.id),
        ...reconnecting.map(r => r.connectionId),
      ]);

      const hasAdded = [...currentIds].some(id => !this.lastKnownConnectionIds.has(id));
      const hasRemoved = [...this.lastKnownConnectionIds].some(id => !currentIds.has(id));

      if (hasAdded || hasRemoved) {
        // Structural change — must do full refresh to add/remove root tree items
        this._onDidChangeTreeData.fire();
      } else {
        // No structural change — use targeted refresh per connection to preserve expansion
        for (const id of currentIds) {
          this.refreshConnection(id);
        }
      }

      this.lastKnownConnectionIds = currentIds;
    }, this.CONNECTION_CHANGE_DEBOUNCE_MS);
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
   * Clears cache and triggers targeted refresh for the affected connection
   */
  refreshFolder(connectionId: string, folderPath: string): void {
    // Clear cache for this folder
    const key = this.getCacheKey(connectionId, folderPath);
    this.directoryCache.delete(key);

    // Use targeted refresh to preserve other connections' tree state
    this.refreshConnection(connectionId);
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
   * Supports:
   * - Plain text: matches anywhere in filename (e.g., "config" matches "config.json", "my-config.ts")
   * - Glob patterns with * or ?: exact pattern match (e.g., "*.ts" matches only .ts files)
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

    // Check if pattern contains glob wildcards
    const hasGlobWildcards = pattern.includes('*') || pattern.includes('?');

    if (!hasGlobWildcards) {
      // Plain text: case-insensitive substring match (like SQL ILIKE)
      return fileName.includes(pattern);
    }

    // Convert glob pattern to regex for wildcard patterns
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
    // Root level: show all connections (active + reconnecting) in custom order
    if (!element) {
      const { active, reconnecting } = this.connectionManager.getAllConnectionsWithReconnecting();
      const items: TreeItem[] = [];

      // Get ordered active connections
      const orderedActive = this.getOrderedConnections();

      // Create tree items for active connections and store refs for targeted refreshes
      for (const conn of orderedActive) {
        const currentPath = this.getCurrentPath(conn.id);
        const item = new ConnectionTreeItem(conn, currentPath);
        // Show connection.filtered contextValue when any filename filter is active on this connection
        const hasFilterOnConnection = Array.from(this.activeFilters.values()).some(f => f.connectionId === conn.id);
        if (hasFilterOnConnection) {
          item.contextValue = 'connection.filtered';
        }
        items.push(item);
        this.connectionTreeItemRefs.set(conn.id, item);
      }

      // Add reconnecting connections (preserving tree data from cache)
      for (const { connectionId, host, attempts } of reconnecting) {
        // Only add if not already in active list
        if (!orderedActive.find(c => c.id === connectionId)) {
          const currentPath = this.getCurrentPath(connectionId);
          const item = new ReconnectingConnectionTreeItem(connectionId, host, currentPath, attempts);
          items.push(item);
          this.connectionTreeItemRefs.set(connectionId, item);
        }
      }

      // Clean up refs for disconnected connections
      for (const id of this.connectionTreeItemRefs.keys()) {
        if (!items.some(i => (i instanceof ConnectionTreeItem && i.connection.id === id) ||
            (i instanceof ReconnectingConnectionTreeItem && i.connectionId === id))) {
          this.connectionTreeItemRefs.delete(id);
        }
      }

      // Preload current directory for active connections in parallel
      this.preloadConnectionDirectories(orderedActive);

      return items;
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
        // Clear pending auto-expand paths after they've been consumed by buildDirectoryItems
        // (child getChildren calls will also read them before this clears)
        setTimeout(() => this.pendingAutoExpandPaths.delete(element.connection.id), 500);
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

    // Reconnecting connection level: show cached directory files (read-only)
    if (element instanceof ReconnectingConnectionTreeItem) {
      const currentPath = this.getCurrentPath(element.connectionId);
      const loadingKey = this.getCacheKey(element.connectionId, currentPath);

      // Show cached data only - don't try to load from server
      const cached = this.getCached(element.connectionId, currentPath);
      if (cached) {
        // Build items but mark them as from a disconnected connection
        return this.buildReconnectingDirectoryItems(element.connectionId, element.host, currentPath, cached);
      }

      // No cache available
      return [new LoadingTreeItem('Waiting for reconnection...', loadingKey)];
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
        // Apply global filter and per-folder filename filter
        const filteredFiles = cached.filter((file) =>
          this.matchesFilter(file) && this.matchesFilenameFilter(element.connection.id, file));
        // Check for pending auto-expand paths (consumed once)
        const autoExpandPaths = this.pendingAutoExpandPaths.get(element.connection.id);
        const items = filteredFiles.map((file) => {
          const isFolderFiltered = file.isDirectory && this.isFilteredFolder(element.connection.id, file.path);
          const isEmpty = this.isEmptyAfterFilter(element.connection.id, file.path, file.isDirectory);
          // Auto-expand folders on the pending expand path
          const shouldAutoExpand = file.isDirectory && autoExpandPaths?.has(file.path);
          const filterKey = `${element.connection.id}:${file.path}`;
          const activeFilter = this.activeFilters.get(filterKey);
          const matchCount = file.isDirectory ? this.getMatchCount(element.connection.id, file.path) : 0;
          return new FileTreeItem(
            file,
            element.connection,
            this.isPathHighlighted(element.connection.id, file),
            this.openFilePaths.has(file.path),
            this.loadingFilePaths.has(file.path),
            shouldAutoExpand || (file.isDirectory && this.isExpanded(element.connection.id, file.path)),
            isFolderFiltered,
            activeFilter?.pattern || '',
            isEmpty,
            matchCount
          );
        });
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

    // Add parent folder navigation (with inline "Show tree from root" button)
    if (currentPath !== '/' && currentPath !== '~') {
      const parentPath = path.posix.dirname(currentPath);
      items.push(new ParentFolderTreeItem(connection, parentPath || '/', currentPath));
      // Preload parent folder for instant navigation
      this.preloadParentFolder(connection, parentPath || '/');
    } else if (currentPath === '~') {
      // Allow going to root from home
      items.push(new ParentFolderTreeItem(connection, '/', currentPath));
      // Preload root for instant navigation
      this.preloadParentFolder(connection, '/');
    }

    // Apply global filter and per-folder filename filter
    const filteredFiles = files.filter((file) =>
      this.matchesFilter(file) && this.matchesFilenameFilter(connection.id, file));
    // Check for pending auto-expand paths (consumed once)
    const autoExpandPaths = this.pendingAutoExpandPaths.get(connection.id);
    items.push(...filteredFiles.map((file) => {
      const isFolderFiltered = file.isDirectory && this.isFilteredFolder(connection.id, file.path);
      const isEmpty = this.isEmptyAfterFilter(connection.id, file.path, file.isDirectory);
      const shouldAutoExpand = file.isDirectory && autoExpandPaths?.has(file.path);
      const filterKey = `${connection.id}:${file.path}`;
      const activeFilter = this.activeFilters.get(filterKey);
      const matchCount = file.isDirectory ? this.getMatchCount(connection.id, file.path) : 0;
      return new FileTreeItem(
        file,
        connection,
        this.isPathHighlighted(connection.id, file),
        this.openFilePaths.has(file.path),
        this.loadingFilePaths.has(file.path),
        shouldAutoExpand || (file.isDirectory && this.isExpanded(connection.id, file.path)),
        isFolderFiltered,
        activeFilter?.pattern || '',
        isEmpty,
        matchCount
      );
    }));

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
   * Build tree items for a reconnecting connection's directory (cached, read-only)
   * Shows files with a grayed-out appearance and no interactive commands
   */
  private buildReconnectingDirectoryItems(
    connectionId: string,
    host: IHostConfig,
    currentPath: string,
    files: IRemoteFile[]
  ): TreeItem[] {
    const items: TreeItem[] = [];

    // Add a "waiting for reconnection" header
    const headerItem = new vscode.TreeItem('⏳ Reconnecting... (cached data)', vscode.TreeItemCollapsibleState.None);
    headerItem.id = `reconnecting-header:${connectionId}`;
    headerItem.iconPath = new vscode.ThemeIcon('sync~spin');
    headerItem.tooltip = 'Connection lost. Auto-reconnecting in background. Cached files shown below.';
    // Cast to TreeItem type
    items.push(headerItem as unknown as TreeItem);

    // Apply global filter and per-folder filename filter (read-only, grayed out)
    const filteredFiles = files.filter((file) =>
      this.matchesFilter(file) && this.matchesFilenameFilter(connectionId, file));
    for (const file of filteredFiles) {
      const item = new vscode.TreeItem(
        file.name,
        file.isDirectory ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.None
      );
      item.id = `reconnecting-file:${connectionId}:${file.path}`;
      item.description = file.isDirectory ? '(folder)' : formatFileSize(file.size);
      item.tooltip = new vscode.MarkdownString(
        `**${file.name}** _(cached)_\n\n` +
        `Path: \`${file.path}\`\n\n` +
        `_Waiting for reconnection to enable actions_`
      );
      // Use grayed icons for disconnected files
      item.iconPath = file.isDirectory
        ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('disabledForeground'))
        : new vscode.ThemeIcon('file', new vscode.ThemeColor('disabledForeground'));
      // No command - files are not clickable during reconnection

      items.push(item as unknown as TreeItem);
    }

    return items;
  }

  /**
   * Preload parent folder for instant "go up" navigation
   * NOTE: Parent folder is ALWAYS preloaded with HIGH priority (not controlled by enablePreloading setting)
   * because it's essential for basic navigation - users expect instant "go to parent"
   * Uses HIGH priority to ensure quick loading but doesn't block CRITICAL operations
   */
  private preloadParentFolder(connection: SSHConnection, parentPath: string): void {
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

    // Parent folder uses HIGH priority - essential for navigation
    this.enqueueDirectoryPreload(connection, parentPath, cacheKey, PreloadPriority.HIGH, 0);
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
   * Uses MEDIUM priority since these are user-important but not immediately needed
   */
  private preloadFrequentFolders(connection: SSHConnection): void {
    // Note: Caller should check isPreloadingEnabled() before calling
    if (this.priorityQueue.isConnectionCancelled(connection.id)) {
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

      // Frequent folders use MEDIUM priority - important but not critical
      this.enqueueDirectoryPreload(connection, folderPath, cacheKey, PreloadPriority.MEDIUM, 1);
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
      return new FileTreeItem(parentFile, element.connection, false, false, false, this.isExpanded(element.connection.id, parentPath));
    }

    if (element instanceof ParentFolderTreeItem) {
      // Navigation items are children of the connection
      const conn = element.connection;
      const currentPath = this.getCurrentPath(conn.id);
      return new ConnectionTreeItem(conn, currentPath);
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
   * @returns Object with hitLimit boolean and count of results
   */
  async searchServerForFilter(): Promise<{ hitLimit: boolean; count: number; limit: number }> {
    if (!this.filterPattern) {
      return { hitLimit: false, count: 0, limit: 0 }; // No filter set
    }
    return await this.startDeepFilter(this.filterPattern);
  }

  /**
   * Start deep filter search on all connections
   * Uses 'find' command to recursively search for matching files
   * LITE PRINCIPLE: Only called when user explicitly requests server search
   * @returns Object with hitLimit boolean and count of results
   */
  private async startDeepFilter(pattern: string): Promise<{ hitLimit: boolean; count: number; limit: number }> {
    this.isDeepFiltering = true;
    this.deepFilterAbortController = new AbortController();
    const signal = this.deepFilterAbortController.signal;

    // Get configurable limit from settings
    const config = vscode.workspace.getConfiguration('sshLite');
    const maxResults = config.get<number>('filterMaxResults', 1000);

    let totalCount = 0;
    let hitLimit = false;

    // Refresh to show "Searching..." indicator
    this._onDidChangeTreeData.fire();

    const connections = this.connectionManager.getAllConnections();

    // Search each connection in parallel
    const searchPromises = connections.map(async (connection) => {
      const currentPath = this.getCurrentPath(connection.id);

      // Convert glob pattern to find pattern
      // For find, we use -iname (case insensitive) with the pattern
      const findPattern = pattern.includes('*') || pattern.includes('?')
        ? pattern
        : `*${pattern}*`; // If no wildcards, wrap with wildcards

      // Get configurable limit from settings
      const config = vscode.workspace.getConfiguration('sshLite');
      const maxResults = config.get<number>('filterMaxResults', 1000);

      // Track activity for this search
      const activityService = ActivityService.getInstance();
      const activityId = activityService.startActivity(
        'search',
        connection.id,
        connection.host.name,
        `Filter: "${pattern.substring(0, 30)}${pattern.length > 30 ? '...' : ''}"`,
        { detail: `in ${currentPath}` }
      );

      try {
        // Execute find command on remote server
        const results = await connection.searchFiles(currentPath, pattern, {
          searchContent: false, // Filename search
          caseSensitive: false,
          maxResults,
        });

        if (signal.aborted) {
          activityService.cancelActivity(activityId);
          return;
        }

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
          totalCount += newFiles.length;
          // Check if this connection hit the limit
          if (results.length >= maxResults) {
            hitLimit = true;
          }
        }

        activityService.completeActivity(activityId, `${results.length} results`);
      } catch (error) {
        // Fail activity tracking on error
        activityService.failActivity(activityId, (error as Error).message);
        // Silently continue with other connections
      }
    });

    await Promise.all(searchPromises);

    if (!signal.aborted) {
      this.isDeepFiltering = false;
      this._onDidChangeTreeData.fire();
    }

    return { hitLimit, count: totalCount, limit: maxResults };
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

    return new FileTreeItem(
      file,
      connection,
      this.isPathHighlighted(connectionId, file),
      this.openFilePaths.has(remotePath),
      this.loadingFilePaths.has(remotePath),
      false // Files are never expanded
    );
  }

  /**
   * Smart reveal: expand tree from current view to the file without resetting/collapsing.
   * Case A: File is under currentPath → load intermediate dirs, use VS Code reveal()
   * Case B: File is outside currentPath → switch to tree-from-root with both paths expanded
   */
  async revealFile(connectionId: string, remotePath: string): Promise<FileTreeItem | undefined> {
    const connection = this.connectionManager.getConnection(connectionId);
    if (!connection) {
      vscode.window.showWarningMessage('Connection not found');
      return undefined;
    }

    // Auto-clear filename filters that would hide the target file
    const fileName = path.posix.basename(remotePath);
    const mockFile: IRemoteFile = {
      name: fileName, path: remotePath, isDirectory: false,
      size: 0, modifiedTime: 0, connectionId,
    };
    if (!this.matchesFilenameFilter(connectionId, mockFile)) {
      // File is hidden by some filter — clear all filters to reveal it
      this.clearFilenameFilter();
    }

    const parentPath = path.posix.dirname(remotePath);

    // Check if file is already visible (parent cached and file exists in it)
    const cachedFiles = this.getCached(connectionId, parentPath);
    if (cachedFiles) {
      const fileExists = cachedFiles.some(f => f.name === fileName || f.path === remotePath);
      if (fileExists) {
        return this.createFileTreeItem(connectionId, remotePath);
      }
    }

    // Resolve ~ to absolute path for comparison
    let currentPath = this.getCurrentPath(connectionId);
    let resolvedCurrentPath = currentPath;
    if (currentPath === '~' || currentPath.startsWith('~/')) {
      try {
        const homePath = (await connection.exec('echo ~')).trim();
        resolvedCurrentPath = currentPath === '~' ? homePath : homePath + currentPath.substring(1);
      } catch {
        resolvedCurrentPath = currentPath;
      }
    }

    // Case A: File is under current path → expand tree down to file
    if (remotePath.startsWith(resolvedCurrentPath + '/') || resolvedCurrentPath === '/') {
      await this.loadIntermediateDirs(connection, resolvedCurrentPath, parentPath);
      this.refreshConnection(connectionId);
      return this.createFileTreeItem(connectionId, remotePath);
    }

    // Case B: File is outside current path → navigate to root with auto-expand
    await this.navigateToRootWithExpand(connection, resolvedCurrentPath, remotePath);
    return this.createFileTreeItem(connectionId, remotePath);
  }

  /**
   * Load all directories between fromPath and toPath into cache for reveal() traversal
   */
  private async loadIntermediateDirs(
    connection: SSHConnection, fromPath: string, toPath: string
  ): Promise<void> {
    // Ensure fromPath is cached
    if (!this.getCached(connection.id, fromPath)) {
      await this.loadDirectory(connection, fromPath, true);
    }

    // Build path from fromPath down to toPath
    const relativePath = fromPath === '/'
      ? toPath.substring(1)
      : toPath.substring(fromPath.length + 1);
    const segments = relativePath.split('/').filter(Boolean);

    let currentDir = fromPath;
    for (const segment of segments) {
      currentDir = currentDir === '/' ? `/${segment}` : `${currentDir}/${segment}`;
      if (!this.getCached(connection.id, currentDir)) {
        try {
          await this.loadDirectory(connection, currentDir, true);
        } catch {
          break; // Stop on permission denied etc.
        }
      }
    }
  }

  /**
   * Navigate to root with auto-expand paths from / down to both the original
   * location and the target file. No special mode — just sets currentPath to /
   * and queues expand paths so getChildren renders them expanded.
   */
  private async navigateToRootWithExpand(
    connection: SSHConnection, originalPath: string, remotePath: string
  ): Promise<void> {
    const parentPath = path.posix.dirname(remotePath);

    // Collect all paths that need auto-expanding:
    // 1. Path from / to original location (preserve user's context)
    // 2. Path from / to target file's parent (reveal the file)
    const expandPaths = new Set<string>();

    let p = originalPath;
    while (p !== '/' && p !== '') {
      expandPaths.add(p);
      p = path.posix.dirname(p);
    }

    p = parentPath;
    while (p !== '/' && p !== '') {
      expandPaths.add(p);
      p = path.posix.dirname(p);
    }

    // Also include any currently expanded folders so they stay expanded
    for (const folder of this.expandedFolders) {
      if (folder.startsWith(`${connection.id}:`)) {
        expandPaths.add(folder.substring(connection.id.length + 1));
      }
    }

    // Queue the expand paths for consumption by getChildren
    this.setAutoExpandPaths(connection.id, expandPaths);

    // Load all ancestor directories for both paths
    await this.loadAncestorDirs(connection, originalPath);
    await this.loadAncestorDirs(connection, parentPath);

    // Also ensure the target parent itself is loaded
    if (!this.getCached(connection.id, parentPath)) {
      try {
        await this.loadDirectory(connection, parentPath, true);
      } catch { /* ignore */ }
    }

    // Switch to root view and refresh
    this.currentPaths.set(connection.id, '/');
    this.refreshConnection(connection.id);
  }

  /**
   * Set filename filter for tree highlighting.
   * Supports multiple simultaneous filters on different folders.
   * @param pattern - Glob-like pattern (e.g., "*.ts", "config*")
   * @param basePath - The folder path to search within
   * @param connection - The SSH connection to search on
   * @param filterMode - What to match: 'files', 'folders', or 'both'
   */
  async setFilenameFilter(pattern: string, basePath: string, connection: SSHConnection, filterMode: FilterMode = 'files'): Promise<void> {
    const filterKey = `${connection.id}:${basePath}`;

    if (!pattern) {
      this.activeFilters.delete(filterKey);
      this._onDidChangeTreeData.fire();
      return;
    }

    const patternLower = pattern.toLowerCase();

    // Show loading status
    const modeLabel = filterMode === 'files' ? 'files' : filterMode === 'folders' ? 'folders' : 'files and folders';
    this.showLoading(`Finding ${modeLabel} matching "${pattern}"...`);

    // Track activity
    const activityService = ActivityService.getInstance();
    const activityId = activityService.startActivity(
      'search',
      connection.id,
      connection.host.name,
      `Filename filter: "${pattern.substring(0, 30)}${pattern.length > 30 ? '...' : ''}"`,
      { detail: `in ${basePath} (${filterMode})` }
    );

    try {
      // Map filter mode to find type
      const findType: 'f' | 'd' | 'both' = filterMode === 'files' ? 'f' : filterMode === 'folders' ? 'd' : 'both';

      // Search for files/folders matching the pattern
      const results = await connection.searchFiles(basePath, pattern, {
        searchContent: false,
        caseSensitive: false,
        maxResults: 500,
        findType,
      });

      // Build highlighted paths set and match counts
      const highlightedPaths = new Set<string>();
      const matchCounts = new Map<string, number>();

      // Add the base path itself so the filtered folder shows visual feedback
      highlightedPaths.add(basePath);

      // Process each match
      for (const result of results) {
        highlightedPaths.add(result.path);
        // Highlight parent directories leading to the file and count matches
        let parentPath = path.posix.dirname(result.path);
        while (parentPath && parentPath !== '/' && parentPath.startsWith(basePath)) {
          highlightedPaths.add(parentPath);
          matchCounts.set(parentPath, (matchCounts.get(parentPath) || 0) + 1);
          if (parentPath === basePath) break;
          parentPath = path.posix.dirname(parentPath);
        }
        // Also count for basePath if not already done by the walk
        if (!parentPath || parentPath === '/' || !parentPath.startsWith(basePath)) {
          matchCounts.set(basePath, (matchCounts.get(basePath) || 0) + 1);
        }
      }

      // Store the filter
      this.activeFilters.set(filterKey, {
        pattern: patternLower,
        basePath,
        connectionId: connection.id,
        highlightedPaths,
        matchCounts,
        filterMode,
      });

      activityService.completeActivity(activityId, `${results.length} results`);
      this.showSuccess(`Found ${results.length} ${modeLabel} matching "${pattern}"`);
    } catch (error) {
      activityService.failActivity(activityId, (error as Error).message);
      vscode.window.showErrorMessage(`Failed to search: ${(error as Error).message}`);
      this.hideLoading();
    }

    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear filename filter(s) and remove highlights.
   * @param filterKey - Optional specific filter key ("connectionId:basePath") to clear. If omitted, clears all.
   */
  clearFilenameFilter(filterKey?: string): void {
    const hadFilters = this.activeFilters.size > 0;
    if (filterKey) {
      this.activeFilters.delete(filterKey);
    } else {
      this.activeFilters.clear();
    }
    if (hadFilters && this.activeFilters.size === 0) {
      this.onFilterClearedCallback?.();
    }
    this._onDidChangeTreeData.fire();
  }

  /**
   * Register a callback invoked when the filename filter is auto-cleared
   * (e.g., during reveal-in-tree when the file would be hidden by the filter).
   */
  setOnFilterCleared(callback: () => void): void {
    this.onFilterClearedCallback = callback;
  }

  /**
   * Check if a file path is highlighted by any active filename filter
   */
  isHighlighted(filePath: string): boolean {
    for (const filter of this.activeFilters.values()) {
      if (filter.highlightedPaths.has(filePath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a file/folder name matches a pattern (substring or glob).
   * Shared helper for shouldHighlightByFilter and isEmptyAfterFilter.
   */
  private nameMatchesPattern(name: string, pattern: string): boolean {
    const hasGlob = pattern.includes('*') || pattern.includes('?');
    if (!hasGlob) {
      return name.includes(pattern);
    }
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    try {
      return new RegExp(`^${regexPattern}$`, 'i').test(name);
    } catch {
      return name.includes(pattern);
    }
  }

  /**
   * Check if a file should be highlighted by local filename matching.
   * This is a fallback when server-side `find` results don't match tree paths
   * (e.g., symlinks, realpath differences).
   * Now also highlights directories whose names match the pattern (fixes grayed-out "rccron" bug).
   */
  private shouldHighlightByFilter(filter: ActiveFilter, file: IRemoteFile): boolean {
    if (!file.path.startsWith(filter.basePath)) {
      return false;
    }
    // In folders-only mode, don't highlight files
    if (filter.filterMode === 'folders' && !file.isDirectory) {
      return false;
    }
    return this.nameMatchesPattern(file.name.toLowerCase(), filter.pattern);
  }

  /**
   * Check if a file is highlighted by ANY active filter
   */
  private isPathHighlighted(connectionId: string, file: IRemoteFile): boolean {
    for (const filter of this.activeFilters.values()) {
      if (filter.connectionId === connectionId &&
          file.path.startsWith(filter.basePath) &&
          (filter.highlightedPaths.has(file.path) || this.shouldHighlightByFilter(filter, file))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get recursive match count for a folder across all active filters
   */
  getMatchCount(connectionId: string, folderPath: string): number {
    let total = 0;
    for (const filter of this.activeFilters.values()) {
      if (filter.connectionId === connectionId) {
        total += filter.matchCounts.get(folderPath) || 0;
      }
    }
    return total;
  }

  /**
   * Check if a file should be shown when filename filter(s) are active.
   * In 'files' mode: non-matching files are hidden, all folders shown (grayed if empty).
   * In 'folders'/'both' modes: nothing hidden, non-matching items grayed out instead.
   */
  private matchesFilenameFilter(connectionId: string, file: IRemoteFile): boolean {
    for (const filter of this.activeFilters.values()) {
      if (filter.connectionId !== connectionId) continue;
      if (!file.path.startsWith(filter.basePath)) continue;

      // Only 'files' mode hides non-matching files; folders/both modes gray out instead
      if (filter.filterMode === 'files') {
        if (file.isDirectory) continue; // Directories always shown in files mode
        if (!filter.highlightedPaths.has(file.path) && !this.shouldHighlightByFilter(filter, file)) {
          return false; // Hide non-matching file
        }
      }
      // 'folders' and 'both' modes: never hide, always show (grayed out via isDimmedByFilter)
    }
    return true;
  }

  /**
   * Check if any filename filter is active
   */
  hasFilenameFilter(): boolean {
    return this.activeFilters.size > 0;
  }

  /**
   * Check if a specific folder is an active filter target
   */
  isFilteredFolder(connectionId: string, folderPath: string): boolean {
    return this.activeFilters.has(`${connectionId}:${folderPath}`);
  }

  /**
   * Check if a file or folder should be dimmed (grayed out) when filename filter is active.
   * An item is dimmed if it's under a filter base path but NOT in highlightedPaths
   * AND its name doesn't match the filter pattern.
   * For files: name match check is skipped in 'folders' mode (files can't match a folder filter).
   */
  isEmptyAfterFilter(connectionId: string, itemPath: string, isDirectory: boolean = true): boolean {
    for (const filter of this.activeFilters.values()) {
      if (filter.connectionId !== connectionId) continue;
      if (!itemPath.startsWith(filter.basePath)) continue;
      // Don't gray out the base path itself (gets blue badge)
      if (itemPath === filter.basePath) continue;

      // Item is in highlighted paths → has matching descendants or is itself a match
      if (filter.highlightedPaths.has(itemPath)) continue;

      // Check if item name matches the pattern to avoid graying items that visually match.
      // Directories: always check (a folder named "src" shouldn't be grayed when filtering for "src")
      // Files: only check if the filter mode includes files ('files' or 'both'),
      //   because in 'folders' mode a file named "src" is NOT a match.
      if (isDirectory || filter.filterMode !== 'folders') {
        const itemName = path.posix.basename(itemPath).toLowerCase();
        if (this.nameMatchesPattern(itemName, filter.pattern)) continue;
      }

      return true; // Dimmed for this filter
    }
    return false;
  }

  /**
   * Get all active filename filter states for decoration provider synchronization.
   */
  getFilenameFilterState(): Array<{ highlightedPaths: Set<string>; basePath: string; connectionId: string }> {
    return Array.from(this.activeFilters.values()).map(f => ({
      highlightedPaths: f.highlightedPaths,
      basePath: f.basePath,
      connectionId: f.connectionId,
    }));
  }

  /**
   * Get filter pattern for a specific folder
   */
  getFilenameFilterPattern(connectionId?: string, basePath?: string): string {
    if (connectionId && basePath) {
      return this.activeFilters.get(`${connectionId}:${basePath}`)?.pattern || '';
    }
    // Return first active filter pattern (backwards compat)
    const first = this.activeFilters.values().next().value;
    return first?.pattern || '';
  }

  /**
   * Get the base path for a filename filter
   */
  getFilenameFilterBasePath(): string {
    const first = this.activeFilters.values().next().value;
    return first?.basePath || '';
  }

  /**
   * Track when a folder is expanded
   * Called from extension.ts via onDidExpandElement
   */
  trackExpand(item: TreeItem): void {
    if (item instanceof FileTreeItem && item.file.isDirectory) {
      const key = `${item.connection.id}:${item.file.path}`;
      this.expandedFolders.add(key);
    } else if (item instanceof ConnectionTreeItem) {
      const key = `connection:${item.connection.id}`;
      this.expandedFolders.add(key);
    }
  }

  /**
   * Track when a folder is collapsed
   * Called from extension.ts via onDidCollapseElement
   */
  trackCollapse(item: TreeItem): void {
    if (item instanceof FileTreeItem && item.file.isDirectory) {
      const key = `${item.connection.id}:${item.file.path}`;
      this.expandedFolders.delete(key);
    } else if (item instanceof ConnectionTreeItem) {
      // Only remove the connection-level key, preserve sub-folder expansion state
      // so re-expanding the connection restores subdirectory expansion.
      // Full cleanup happens in clearExpansionState() on disconnect.
      const connKey = `connection:${item.connection.id}`;
      this.expandedFolders.delete(connKey);
    }
  }

  /**
   * Check if a folder should be in expanded state
   */
  isExpanded(connectionId: string, folderPath: string): boolean {
    const key = `${connectionId}:${folderPath}`;
    return this.expandedFolders.has(key);
  }

  /**
   * Clear expansion state for a connection (called on disconnect)
   */
  clearExpansionState(connectionId?: string): void {
    if (connectionId) {
      const prefix = `${connectionId}:`;
      const connKey = `connection:${connectionId}`;
      for (const key of Array.from(this.expandedFolders)) {
        if (key.startsWith(prefix) || key === connKey) {
          this.expandedFolders.delete(key);
        }
      }
      // Also clear the connection tree item reference
      this.connectionTreeItemRefs.delete(connectionId);
    } else {
      this.expandedFolders.clear();
      this.connectionTreeItemRefs.clear();
    }
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
    this.expandedFolders.clear();
    this.connectionTreeItemRefs.clear();

    // Clear debounce timer
    if (this.connectionChangeDebounceTimer) {
      clearTimeout(this.connectionChangeDebounceTimer);
      this.connectionChangeDebounceTimer = null;
    }

    // Cancel any running deep filter
    if (this.deepFilterAbortController) {
      this.deepFilterAbortController.abort();
    }
    this.deepFilterResults.clear();
    this.activeFilters.clear();
  }
}
