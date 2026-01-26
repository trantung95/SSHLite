import * as vscode from 'vscode';
import { FileService } from '../services/FileService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { normalizeLocalPath } from '../utils/helpers';

/**
 * Provides file decorations for SSH temp files:
 * - Upload state badge (↑ uploading, ✗ failed) on tab
 * - Grayed-out tab decoration for SSH temp files without active connection (file:// URIs)
 */
export class SSHFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private disposables: vscode.Disposable[] = [];
  private fileService: FileService;
  private connectionManager: ConnectionManager;
  private tempDir: string;

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

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
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
