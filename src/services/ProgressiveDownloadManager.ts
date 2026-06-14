import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SSHConnection } from '../connection/SSHConnection';
import { assertCapability } from '../utils/capabilityGuard';
import { IRemoteFile } from '../types';
import { ProgressiveFileContentProvider } from '../providers/ProgressiveFileContentProvider';
import {
  DownloadState,
  ProgressiveConfig,
  createPreviewUri,
  isLikelyBinary,
  loadProgressiveConfig,
} from '../types/progressive';
import { formatFileSize, normalizeLocalPath } from '../utils/helpers';
import { buildLocalTempPath } from '../utils/connectionPrefix';

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
   * Uses [tabLabel] or [user@host] prefix for server identification in tabs
   */
  private getLocalFilePath(connectionId: string, remotePath: string): string {
    // Shared layout with FileService.getLocalFilePath: a per-remote-folder
    // subdirectory keeps same-named files in different folders from colliding
    // on one temp file (large files go through this path).
    const { dir, filePath } = buildLocalTempPath(this.tempDir, connectionId, remotePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Normalize so this exactly matches FileService.getLocalFilePath (which also
    // normalizes). Without this, a Windows uppercase drive letter here would not
    // match VS Code's lowercased URI fsPath in cancelDownloadByUri, and the
    // reopen/"already open" detection across the two services would miss.
    return normalizeLocalPath(filePath);
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
    // Chunked download uses SSH-only readFileChunked (dd/tail over exec). FTP
    // callers must use the plain readFile path; openRemoteFile already routes
    // them there, this is the backstop.
    assertCapability(connection, 'supportsExec');
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
    // Check if preview document is still open
    let previewWasOpen = false;
    let savedScrollPosition: { line: number; character: number } | null = null;

    if (state.previewUri) {
      const previewDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === state.previewUri?.toString()
      );

      if (previewDoc) {
        // Find the editor showing this document
        const editors = vscode.window.visibleTextEditors.filter(
          (e) => e.document.uri.toString() === state.previewUri?.toString()
        );

        if (editors.length > 0) {
          previewWasOpen = true;
          // Save the current scroll/cursor position before closing
          const activeEditor = editors[0];
          savedScrollPosition = {
            line: activeEditor.visibleRanges[0]?.start.line ?? 0,
            character: 0,
          };

          // Close the preview editor
          for (const editor of editors) {
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
          }
        }
      }

      // Stop tail following
      if (this.contentProvider) {
        this.contentProvider.stopTailFollow(state.previewUri);
        this.contentProvider.clearCache(state.previewUri);
      }
    }

    // Only open the editable document if the preview was still open
    // This respects the user's intent - if they closed the preview, don't re-open
    if (previewWasOpen) {
      const document = await vscode.workspace.openTextDocument(localPath);
      const editor = await vscode.window.showTextDocument(document, { preview: false });

      // Restore scroll position to where user was viewing
      if (savedScrollPosition && editor) {
        const position = new vscode.Position(savedScrollPosition.line, savedScrollPosition.character);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.AtTop
        );
      }

      // Show brief status bar notification
      vscode.window.setStatusBarMessage(
        `$(check) Download complete: ${path.basename(localPath)} is now editable`,
        5000
      );
    } else {
      // Preview was closed by user - just show a notification, don't open the file
      vscode.window.setStatusBarMessage(
        `$(check) Download complete: ${path.basename(localPath)} (saved to temp)`,
        5000
      );
    }
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
   * Matches by preview URI, local path, or remote path in URI
   */
  public cancelDownloadByUri(uri: vscode.Uri): boolean {
    const uriString = uri.toString();
    const fsPath = normalizeLocalPath(uri.fsPath);
    const scheme = uri.scheme;

    // Snapshot to prevent concurrent modification during iteration
    const downloadsSnapshot = Array.from(this.downloads.entries());

    for (const [id, state] of downloadsSnapshot) {
      // Skip already completed/cancelled/error downloads
      if (state.status !== 'downloading' && state.status !== 'pending') {
        continue;
      }

      let isMatch = false;

      // Check if this is the preview URI (scheme: ssh-lite-preview)
      if (state.previewUri?.toString() === uriString) {
        isMatch = true;
      }
      // Check if this is the local file path
      else if (state.localPath && state.localPath === fsPath) {
        isMatch = true;
      }
      // Check if URI contains the remote filename (for ssh-lite-preview scheme)
      else if (scheme === 'ssh-lite-preview') {
        const remoteName = state.remotePath.split('/').pop();
        if (remoteName && uriString.includes(encodeURIComponent(remoteName))) {
          isMatch = true;
        }
      }
      // Check if local path contains the remote filename (for file scheme)
      else if (scheme === 'file' && state.localPath) {
        const remoteName = state.remotePath.split('/').pop();
        if (remoteName && fsPath.includes(remoteName)) {
          isMatch = true;
        }
      }

      if (isMatch) {
        this.cancelDownload(id);
        const fileName = state.remotePath.split('/').pop() || 'file';
        vscode.window.setStatusBarMessage(`$(x) Download cancelled: ${fileName}`, 3000);

        // Also stop tail following and clean up preview cache
        if (this.contentProvider && state.previewUri) {
          this.contentProvider.stopTailFollow(state.previewUri);
          this.contentProvider.clearCache(state.previewUri);
        }

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
