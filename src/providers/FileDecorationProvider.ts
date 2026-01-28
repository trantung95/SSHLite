import * as vscode from 'vscode';
import { FileService } from '../services/FileService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { normalizeLocalPath } from '../utils/helpers';

/**
 * Provides file decorations for SSH temp files:
 * - Upload state badge (↑ uploading, ✗ failed) on tab
 * - Grayed-out tab decoration for SSH temp files without active connection (file:// URIs)
 * - Blue highlight for filtered folders in the file tree (ssh:// URIs)
 */
export class SSHFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private disposables: vscode.Disposable[] = [];
  private fileService: FileService;
  private connectionManager: ConnectionManager;
  private tempDir: string;

  // Filtered folder URI string (e.g., "ssh://connId/path/to/folder")
  private filteredFolderUri: string = '';

  // Filename filter state for empty folder graying
  private filterHighlightedUris: Set<string> = new Set();
  private filterBasePathPrefix: string = '';  // "ssh://connId/basePath/"

  constructor(fileService: FileService, connectionManager: ConnectionManager) {
    this.fileService = fileService;
    this.connectionManager = connectionManager;
    this.tempDir = fileService.getTempDir();

    // Subscribe to file mapping changes (for live-refresh tab decorations)
    this.disposables.push(
      fileService.onFileMappingsChanged(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );

    // Subscribe to upload state changes (uploading/failed badges)
    this.disposables.push(
      fileService.onUploadStateChanged(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );

    // Subscribe to connection state changes (connect/disconnect/drop)
    this.disposables.push(
      connectionManager.onDidChangeConnections(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );
    this.disposables.push(
      connectionManager.onConnectionStateChange(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      })
    );
  }

  /**
   * Set the filtered folder to highlight in the tree view.
   * Pass empty string to clear.
   */
  setFilteredFolder(connectionId: string, folderPath: string): void {
    const newUri = connectionId ? `ssh://${connectionId}${folderPath}` : '';
    if (newUri !== this.filteredFolderUri) {
      this.filteredFolderUri = newUri;
      this._onDidChangeFileDecorations.fire(undefined);
    }
  }

  /**
   * Clear the filtered folder highlight and empty folder graying.
   */
  clearFilteredFolder(): void {
    if (this.filteredFolderUri || this.filterHighlightedUris.size > 0) {
      this.filteredFolderUri = '';
      this.filterHighlightedUris.clear();
      this.filterBasePathPrefix = '';
      this._onDidChangeFileDecorations.fire(undefined);
    }
  }

  /**
   * Set highlighted paths for filename filter (for empty folder graying).
   * Folders under basePath that are NOT in highlightedPaths will be grayed out.
   */
  setFilenameFilterPaths(highlightedPaths: Set<string>, basePath: string, connectionId: string): void {
    if (!connectionId || !basePath) {
      return;
    }

    this.filterHighlightedUris.clear();
    this.filterBasePathPrefix = `ssh://${connectionId}${basePath}/`;

    for (const p of highlightedPaths) {
      this.filterHighlightedUris.add(`ssh://${connectionId}${p}`);
    }

    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // Handle ssh:// URIs — highlight filtered folder and gray out empty folders
    if (uri.scheme === 'ssh') {
      const uriString = uri.toString();

      // Blue badge for the filtered folder itself
      if (this.filteredFolderUri && uriString === this.filteredFolderUri) {
        return {
          badge: 'F',
          color: new vscode.ThemeColor('charts.blue'),
          tooltip: 'Filtered folder',
        };
      }

      // Gray out empty folders (under basePath, not in highlightedPaths)
      if (this.filterBasePathPrefix && uriString.startsWith(this.filterBasePathPrefix)
          && !this.filterHighlightedUris.has(uriString)) {
        return {
          color: new vscode.ThemeColor('disabledForeground'),
          tooltip: 'No matching files in this folder',
        };
      }
    }

    // Handle file:// URIs — gray out SSH temp files that are not live-refreshing
    if (uri.scheme === 'file') {
      const filePath = normalizeLocalPath(uri.fsPath);

      // Only decorate files in the SSH temp directory
      if (!filePath.startsWith(this.tempDir)) {
        return undefined;
      }

      // Upload state badges take priority
      if (this.fileService.isFileUploading(filePath)) {
        return {
          badge: '↑',
          color: new vscode.ThemeColor('charts.yellow'),
          tooltip: 'Uploading to server...',
        };
      }

      if (this.fileService.isFileUploadFailed(filePath)) {
        return {
          badge: '✗',
          color: new vscode.ThemeColor('errorForeground'),
          tooltip: 'Upload failed — save again to retry',
        };
      }

      // Check if this file has an active mapping
      const mapping = this.fileService.getFileMapping(filePath);
      if (!mapping) {
        // SSH temp file with no mapping — orphaned/stale
        return {
          color: new vscode.ThemeColor('disabledForeground'),
          tooltip: 'Not connected — click "Reconnect" to enable live refresh',
        };
      }

      // Has mapping — check if the connection is still active
      const connection = this.connectionManager.getConnection(mapping.connectionId);
      if (!connection) {
        // Mapping exists but connection dropped
        return {
          color: new vscode.ThemeColor('disabledForeground'),
          tooltip: 'Connection lost — file is not being refreshed',
        };
      }

      // File is live — no special decoration needed
      return undefined;
    }

    return undefined;
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
