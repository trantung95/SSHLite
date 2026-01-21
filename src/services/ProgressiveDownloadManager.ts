import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { ProgressiveFileContentProvider } from '../providers/ProgressiveFileContentProvider';
import {
  DownloadState,
  ProgressiveConfig,
  createPreviewUri,
  isLikelyBinary,
  loadProgressiveConfig,
} from '../types/progressive';
import { formatFileSize } from '../utils/helpers';

/**
 * Manages progressive file downloads with real progress tracking
 *
 * Orchestrates the two-phase download process:
 * 1. Instant preview via tail command
 * 2. Background download with real SFTP progress
 *
 * Features:
 * - Real progress tracking using chunked SFTP reads
 * - Cancellation support
 * - State machine for download lifecycle
 * - Integration with FileService for file mapping
 */
export class ProgressiveDownloadManager {
  private static _instance: ProgressiveDownloadManager;

  // Active downloads
  private downloads: Map<string, DownloadState> = new Map();

  // Lock for atomic download state operations
  private downloadLock: Promise<void> = Promise.resolve();

  // Content provider reference
  private contentProvider: ProgressiveFileContentProvider | null = null;

  // Temp directory for downloads
  private readonly tempDir: string;

  // Event emitters
  private readonly _onDownloadProgress = new vscode.EventEmitter<DownloadState>();
  public readonly onDownloadProgress = this._onDownloadProgress.event;

  private readonly _onDownloadComplete = new vscode.EventEmitter<{ state: DownloadState; localPath: string }>();
  public readonly onDownloadComplete = this._onDownloadComplete.event;

  private readonly _onDownloadError = new vscode.EventEmitter<{ state: DownloadState; error: Error }>();
  public readonly onDownloadError = this._onDownloadError.event;

  // Configuration
  private config: ProgressiveConfig;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'ssh-lite');
    this.ensureTempDir();
    this.config = loadProgressiveConfig();

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
  public static getInstance(): ProgressiveDownloadManager {
    if (!ProgressiveDownloadManager._instance) {
      ProgressiveDownloadManager._instance = new ProgressiveDownloadManager();
    }
    return ProgressiveDownloadManager._instance;
  }

  /**
   * Initialize with content provider
   */
  public initialize(contentProvider: ProgressiveFileContentProvider): void {
    this.contentProvider = contentProvider;
  }

  /**
   * Ensure temp directory exists
   */
  private ensureTempDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Get local file path for a remote file
   */
  private getLocalFilePath(connectionId: string, remotePath: string): string {
    // Create subdirectory for each connection using hash
    const connectionHash = crypto.createHash('md5').update(connectionId).digest('hex').substring(0, 8);
    const connectionDir = path.join(this.tempDir, connectionHash);

    if (!fs.existsSync(connectionDir)) {
      fs.mkdirSync(connectionDir, { recursive: true });
    }

    // Use original filename
    const fileName = path.basename(remotePath);
    return path.join(connectionDir, fileName);
  }

  /**
   * Check if a file should use progressive download
   */
  public shouldUseProgressiveDownload(fileSize: number, fileName: string): boolean {
    // Don't use progressive download for binary files
    if (isLikelyBinary(fileName)) {
      return false;
    }

    // Check size threshold
    return fileSize >= this.config.threshold;
  }

  /**
   * Start progressive download for a file
   * Returns immediately after showing preview, downloads in background
   */
  public async startProgressiveDownload(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    const downloadId = `${connection.id}:${remoteFile.path}`;

    // Acquire lock for atomic check-and-set of download state
    const previousLock = this.downloadLock;
    let releaseLock: () => void;
    this.downloadLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousLock;

    // Check if already downloading (now atomic with state set)
    const existing = this.downloads.get(downloadId);
    if (existing && (existing.status === 'downloading' || existing.status === 'pending')) {
      releaseLock!();
      vscode.window.showWarningMessage(`Already downloading: ${remoteFile.name}`);
      return;
    }

    // Create download state
    const state: DownloadState = {
      id: downloadId,
      remotePath: remoteFile.path,
      connectionId: connection.id,
      totalBytes: remoteFile.size,
      downloadedBytes: 0,
      status: 'pending',
      startTime: Date.now(),
      connection,
    };

    this.downloads.set(downloadId, state);

    // Release lock after state is set
    releaseLock!();

    try {
      // Phase 1: Show preview immediately
      await this.showPreview(connection, remoteFile, state);

      // Phase 2: Download full file in background
      await this.downloadInBackground(connection, remoteFile, state);
    } catch (error) {
      this.handleDownloadError(state, error as Error);
    }
  }

  /**
   * Phase 1: Show preview using tail command
   */
  private async showPreview(
    connection: SSHConnection,
    remoteFile: IRemoteFile,
    state: DownloadState
  ): Promise<void> {
    const lines = this.config.previewLines;
    const previewUri = createPreviewUri(connection.id, remoteFile.path, lines);
    state.previewUri = previewUri;

    // Open the preview document
    const doc = await vscode.workspace.openTextDocument(previewUri);
    await vscode.window.showTextDocument(doc, { preview: false });

    // Start tail following if enabled
    if (this.contentProvider && this.config.tailFollowEnabled) {
      this.contentProvider.startTailFollow(previewUri, connection);
    }

    // Show status message
    const sizeStr = formatFileSize(remoteFile.size);
    vscode.window.setStatusBarMessage(
      `$(eye) Preview loaded. Downloading full file (${sizeStr}) in background...`,
      5000
    );
  }

  /**
   * Phase 2: Download full file in background with real progress
   */
  private async downloadInBackground(
    connection: SSHConnection,
    remoteFile: IRemoteFile,
    state: DownloadState
  ): Promise<void> {
    const localPath = this.getLocalFilePath(connection.id, remoteFile.path);
    state.localPath = localPath;
    state.status = 'downloading';

    // Create cancellation token
    const cancelTokenSource = new vscode.CancellationTokenSource();
    state.cancelTokenSource = cancelTokenSource;

    const sizeStr = formatFileSize(remoteFile.size);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${remoteFile.name} (${sizeStr})`,
        cancellable: true,
      },
      async (progress, token) => {
        // Handle cancellation
        const abortSignal = { aborted: false };
        token.onCancellationRequested(() => {
          abortSignal.aborted = true;
          state.status = 'cancelled';
        });

        try {
          let lastPercent = 0;

          // Download with real progress tracking
          const content = await connection.readFileChunked(
            remoteFile.path,
            (transferred, total) => {
              const percent = Math.floor((transferred / total) * 100);

              // Update state
              state.downloadedBytes = transferred;

              // Update VS Code progress
              if (percent > lastPercent) {
                const increment = percent - lastPercent;
                lastPercent = percent;
                progress.report({
                  increment,
                  message: `${formatFileSize(transferred)} / ${formatFileSize(total)} (${percent}%)`,
                });
              }

              // Update preview banner
              if (this.contentProvider && state.previewUri) {
                this.contentProvider.updateDownloadProgress(state.previewUri, percent);
              }

              // Emit progress event
              this._onDownloadProgress.fire(state);
            },
            abortSignal,
            this.config.chunkSize
          );

          // Check for cancellation
          if (token.isCancellationRequested) {
            vscode.window.setStatusBarMessage(
              `$(x) Download cancelled: ${remoteFile.name} (preview still available)`,
              5000
            );
            return;
          }

          // Write to disk
          this.ensureTempDir();
          fs.writeFileSync(localPath, content);

          // Mark download complete
          state.status = 'completed';
          state.downloadedBytes = state.totalBytes;

          // Update preview banner
          if (this.contentProvider && state.previewUri) {
            this.contentProvider.markDownloadComplete(state.previewUri);
          }

          // Emit completion event
          this._onDownloadComplete.fire({ state, localPath });

          // Transition to editable file
          await this.transitionToEditableFile(localPath, state);
        } catch (error) {
          if (!token.isCancellationRequested) {
            throw error;
          }
        }
      }
    );
  }

  /**
   * Transition from preview to editable file
   */
  private async transitionToEditableFile(localPath: string, state: DownloadState): Promise<void> {
    // Close preview document if open
    if (state.previewUri) {
      const previewDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === state.previewUri?.toString()
      );

      if (previewDoc) {
        // Find the editor showing this document and close it
        const editors = vscode.window.visibleTextEditors.filter(
          (e) => e.document.uri.toString() === state.previewUri?.toString()
        );

        for (const editor of editors) {
          await vscode.window.showTextDocument(editor.document);
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }

      // Stop tail following
      if (this.contentProvider) {
        this.contentProvider.stopTailFollow(state.previewUri);
        this.contentProvider.clearCache(state.previewUri);
      }
    }

    // Open the full editable document
    const document = await vscode.workspace.openTextDocument(localPath);
    await vscode.window.showTextDocument(document, { preview: false });

    // Show brief status bar notification (auto-dismiss to avoid cluttering screen)
    vscode.window.setStatusBarMessage(
      `$(check) Download complete: ${path.basename(localPath)} is now editable`,
      5000
    );
  }

  /**
   * Handle download error
   */
  private handleDownloadError(state: DownloadState, error: Error): void {
    state.status = 'error';
    state.errorMessage = error.message;

    // Emit error event
    this._onDownloadError.fire({ state, error });

    // Show error message
    vscode.window.showErrorMessage(
      `Download failed: ${error.message}. Preview remains available.`
    );
  }

  /**
   * Cancel an active download
   */
  public cancelDownload(downloadId: string): void {
    const state = this.downloads.get(downloadId);
    if (state?.cancelTokenSource) {
      state.cancelTokenSource.cancel();
      state.status = 'cancelled';
    }
  }

  /**
   * Get download state
   */
  public getDownloadState(downloadId: string): DownloadState | undefined {
    return this.downloads.get(downloadId);
  }

  /**
   * Get all active downloads
   */
  public getActiveDownloads(): DownloadState[] {
    return Array.from(this.downloads.values()).filter(
      (d) => d.status === 'downloading' || d.status === 'pending'
    );
  }

  /**
   * Check if a download is in progress for a file
   */
  public isDownloading(connectionId: string, remotePath: string): boolean {
    const downloadId = `${connectionId}:${remotePath}`;
    const state = this.downloads.get(downloadId);
    return state?.status === 'downloading' || state?.status === 'pending';
  }

  /**
   * Get local path for a completed download
   */
  public getLocalPath(connectionId: string, remotePath: string): string | undefined {
    const downloadId = `${connectionId}:${remotePath}`;
    const state = this.downloads.get(downloadId);
    if (state?.status === 'completed') {
      return state.localPath;
    }
    return undefined;
  }

  /**
   * Cancel download by document URI (called when tab is closed)
   * Matches by preview URI or local path
   */
  public cancelDownloadByUri(uri: vscode.Uri): boolean {
    const uriString = uri.toString();
    const fsPath = uri.fsPath;

    // Snapshot to prevent concurrent modification during iteration
    const downloadsSnapshot = Array.from(this.downloads.entries());

    for (const [id, state] of downloadsSnapshot) {
      // Check if this is the preview URI or the local path
      const isMatch =
        state.previewUri?.toString() === uriString ||
        state.localPath === fsPath ||
        (state.localPath && fsPath.includes(state.remotePath.split('/').pop() || ''));

      if (isMatch && (state.status === 'downloading' || state.status === 'pending')) {
        this.cancelDownload(id);
        vscode.window.setStatusBarMessage(`$(x) Download cancelled: ${state.remotePath.split('/').pop()}`, 3000);
        return true;
      }
    }
    return false;
  }

  /**
   * Clean up completed/cancelled downloads
   */
  public cleanupDownloads(): void {
    // Snapshot to prevent concurrent modification during iteration
    const downloadsSnapshot = Array.from(this.downloads.entries());

    for (const [id, state] of downloadsSnapshot) {
      if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'error') {
        this.downloads.delete(id);
      }
    }
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
    // Snapshot to prevent concurrent modification during iteration
    const downloadsSnapshot = Array.from(this.downloads.values());

    // Cancel all active downloads
    for (const state of downloadsSnapshot) {
      if (state.cancelTokenSource) {
        state.cancelTokenSource.cancel();
      }
    }
    this.downloads.clear();

    this._onDownloadProgress.dispose();
    this._onDownloadComplete.dispose();
    this._onDownloadError.dispose();
  }
}
