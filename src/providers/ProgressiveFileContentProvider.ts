import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import {
  PROGRESSIVE_PREVIEW_SCHEME,
  parsePreviewUri,
  createPreviewUri,
  ProgressiveConfig,
  loadProgressiveConfig,
} from '../types/progressive';
import { formatFileSize } from '../utils/helpers';
import { PriorityQueueService, PreloadPriority } from '../services/PriorityQueueService';

/**
 * Content provider for progressive file preview
 *
 * Provides read-only preview of large files by showing the last N lines
 * immediately, while the full file downloads in the background.
 *
 * Features:
 * - Instant preview via tail command (<5 seconds)
 * - Live tail following for growing files
 * - Banner showing download status
 * - Automatic updates via onDidChange
 */
export class ProgressiveFileContentProvider implements vscode.TextDocumentContentProvider {
  private static _instance: ProgressiveFileContentProvider;

  // Event emitter for document content changes
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  // Cache for preview content
  private previewCache: Map<string, {
    content: string;
    lastUpdate: number;
    lineCount: number;
    fileSize: number;
    isDownloading: boolean;
    downloadProgress: number;
    fileName: string;
  }> = new Map();

  // Active tail followers
  private tailFollowers: Map<string, {
    connectionId: string;
    remotePath: string;
    intervalId: NodeJS.Timeout | null;
    lastLineCount: number;
  }> = new Map();

  // Configuration
  private config: ProgressiveConfig;

  // Priority queue for tail-f operations
  private priorityQueue: PriorityQueueService;

  constructor() {
    this.config = loadProgressiveConfig();
    this.priorityQueue = PriorityQueueService.getInstance();

    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshLite')) {
        this.config = loadProgressiveConfig();
      }
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ProgressiveFileContentProvider {
    if (!ProgressiveFileContentProvider._instance) {
      ProgressiveFileContentProvider._instance = new ProgressiveFileContentProvider();
    }
    return ProgressiveFileContentProvider._instance;
  }

  /**
   * Get the URI scheme for this provider
   */
  public get scheme(): string {
    return PROGRESSIVE_PREVIEW_SCHEME;
  }

  /**
   * Provide text document content for preview URI
   * Called by VS Code when opening a document with our scheme
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parsePreviewUri(uri);
    if (!parsed) {
      return '// Error: Invalid preview URI';
    }

    const { connectionId, remotePath, lines } = parsed;
    const cacheKey = uri.toString();

    // Check cache first
    const cached = this.previewCache.get(cacheKey);
    if (cached && Date.now() - cached.lastUpdate < 1000) {
      return this.formatPreviewContent(cached);
    }

    // Fetch preview content from server
    try {
      const content = await this.fetchPreviewContent(connectionId, remotePath, lines);
      return content;
    } catch (error) {
      return `// Error loading preview: ${(error as Error).message}\n// Connection: ${connectionId}\n// Path: ${remotePath}`;
    }
  }

  /**
   * Fetch preview content from remote server
   */
  private async fetchPreviewContent(
    connectionId: string,
    remotePath: string,
    lineCount: number
  ): Promise<string> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(connectionId);

    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    // Get file stats for display
    const stats = await connection.stat(remotePath);

    // Fetch last N lines using tail command
    const tailContent = await connection.readFileLastLines(remotePath, lineCount);

    // Cache the content - use createPreviewUri for consistent cache key format
    const cacheKey = createPreviewUri(connectionId, remotePath, lineCount).toString();
    this.previewCache.set(cacheKey, {
      content: tailContent,
      lastUpdate: Date.now(),
      lineCount,
      fileSize: stats.size,
      isDownloading: true,
      downloadProgress: 0,
      fileName: path.basename(remotePath),
    });

    return this.formatPreviewContent(this.previewCache.get(cacheKey)!);
  }

  /**
   * Format preview content with header banner
   */
  private formatPreviewContent(cached: {
    content: string;
    lineCount: number;
    fileSize: number;
    isDownloading: boolean;
    downloadProgress: number;
    fileName: string;
  }): string {
    const sizeStr = formatFileSize(cached.fileSize);
    const downloadStatus = cached.isDownloading
      ? `Downloading... ${cached.downloadProgress}%`
      : 'Download complete - close this preview and open from tree to edit';

    const header = [
      `// ═══════════════════════════════════════════════════════════════════════════════`,
      `// PREVIEW: ${cached.fileName} (${sizeStr})`,
      `// Showing last ${cached.lineCount} lines`,
      `// ${downloadStatus}`,
      `// ═══════════════════════════════════════════════════════════════════════════════`,
      ``,
    ].join('\n');

    return header + cached.content;
  }

  /**
   * Start live tail following for a preview
   * Updates the preview with new lines as they are appended to the file
   */
  public startTailFollow(uri: vscode.Uri, connection: SSHConnection): void {
    if (!this.config.tailFollowEnabled) {
      return;
    }

    const parsed = parsePreviewUri(uri);
    if (!parsed) {
      return;
    }

    const key = uri.toString();

    // Stop any existing follower
    this.stopTailFollow(uri);

    // Start polling for new content using priority queue with LOW priority
    const intervalId = setInterval(async () => {
      try {
        // Use priority queue to avoid overwhelming the server
        await this.priorityQueue.enqueue(
          parsed.connectionId,
          `tail-follow:${key}`,
          PreloadPriority.LOW, // Priority 3 - runs when 3+ slots available
          async () => {
            await this.updatePreviewContent(uri, connection);
          }
        );
      } catch {
        // Ignore errors during tail follow - connection might be down
      }
    }, this.config.tailPollInterval);

    this.tailFollowers.set(key, {
      connectionId: parsed.connectionId,
      remotePath: parsed.remotePath,
      intervalId,
      lastLineCount: parsed.lines,
    });
  }

  /**
   * Stop tail following for a preview
   */
  public stopTailFollow(uri: vscode.Uri): void {
    const key = uri.toString();
    const follower = this.tailFollowers.get(key);

    if (follower?.intervalId) {
      clearInterval(follower.intervalId);
    }

    this.tailFollowers.delete(key);
  }

  /**
   * Stop all tail followers
   */
  public stopAllTailFollowers(): void {
    for (const [key, follower] of this.tailFollowers) {
      if (follower.intervalId) {
        clearInterval(follower.intervalId);
      }
    }
    this.tailFollowers.clear();
  }

  /**
   * Update preview content with latest tail
   */
  private async updatePreviewContent(uri: vscode.Uri, connection: SSHConnection): Promise<void> {
    const parsed = parsePreviewUri(uri);
    if (!parsed) {
      return;
    }

    const cacheKey = uri.toString();
    const cached = this.previewCache.get(cacheKey);

    if (!cached) {
      return;
    }

    try {
      // Fetch latest content
      const newContent = await connection.readFileLastLines(parsed.remotePath, parsed.lines);

      // Only update if content changed
      if (newContent !== cached.content) {
        cached.content = newContent;
        cached.lastUpdate = Date.now();

        // Notify VS Code that content changed
        this._onDidChange.fire(uri);
      }
    } catch {
      // Ignore errors - file might have been deleted or connection lost
    }
  }

  /**
   * Update download progress for a preview
   */
  public updateDownloadProgress(uri: vscode.Uri, progress: number): void {
    const cacheKey = uri.toString();
    const cached = this.previewCache.get(cacheKey);

    if (cached) {
      cached.downloadProgress = progress;
      cached.lastUpdate = Date.now();
      this._onDidChange.fire(uri);
    }
  }

  /**
   * Mark download as complete for a preview
   */
  public markDownloadComplete(uri: vscode.Uri): void {
    const cacheKey = uri.toString();
    const cached = this.previewCache.get(cacheKey);

    if (cached) {
      cached.isDownloading = false;
      cached.downloadProgress = 100;
      cached.lastUpdate = Date.now();
      this._onDidChange.fire(uri);
    }

    // Stop tail following
    this.stopTailFollow(uri);
  }

  /**
   * Clear cache for a specific preview
   */
  public clearCache(uri: vscode.Uri): void {
    const cacheKey = uri.toString();
    this.previewCache.delete(cacheKey);
    this.stopTailFollow(uri);
  }

  /**
   * Clear all cached previews
   */
  public clearAllCache(): void {
    this.previewCache.clear();
    this.stopAllTailFollowers();
  }

  /**
   * Check if a preview is currently cached
   */
  public hasPreview(uri: vscode.Uri): boolean {
    return this.previewCache.has(uri.toString());
  }

  /**
   * Get current configuration
   */
  public getConfig(): ProgressiveConfig {
    return { ...this.config };
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stopAllTailFollowers();
    this.previewCache.clear();
    this._onDidChange.dispose();
  }
}
