import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { AuditService } from './AuditService';
import { formatFileSize } from '../utils/helpers';

/**
 * Large file size threshold (100MB default)
 */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;

/**
 * Mapping from local temp file to remote file info
 */
interface FileMapping {
  connectionId: string;
  remotePath: string;
  localPath: string;
  lastSyncTime: number;
  lastRemoteModTime?: number;
  originalContent?: string; // For diff tracking
}

/**
 * Service for file operations and auto-sync
 */
export class FileService {
  private static _instance: FileService;

  private tempDir: string;
  private fileMappings: Map<string, FileMapping> = new Map(); // localPath -> mapping
  private saveListenerDisposable: vscode.Disposable | null = null;
  private configChangeListener: vscode.Disposable | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private globalRefreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing: boolean = false;
  private auditService: AuditService;

  private constructor() {
    this.tempDir = path.join(os.tmpdir(), 'ssh-lite');
    this.ensureTempDir();
    this.setupSaveListener();
    this.setupConfigListener();
    this.auditService = AuditService.getInstance();
    this.startGlobalRefreshTimer();
  }

  /**
   * Listen for configuration changes to restart refresh timer
   */
  private setupConfigListener(): void {
    this.configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshLite.fileRefreshIntervalSeconds')) {
        this.restartGlobalRefreshTimer();
      }
    });
  }

  /**
   * Restart global refresh timer (when config changes)
   */
  private restartGlobalRefreshTimer(): void {
    this.stopGlobalRefreshTimer();
    this.startGlobalRefreshTimer();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): FileService {
    if (!FileService._instance) {
      FileService._instance = new FileService();
    }
    return FileService._instance;
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
   * Setup listener for file saves
   */
  private setupSaveListener(): void {
    this.saveListenerDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
      this.handleFileSave(document);
    });
  }

  /**
   * Handle file save event
   */
  private handleFileSave(document: vscode.TextDocument): void {
    const config = vscode.workspace.getConfiguration('sshLite');
    const autoUpload = config.get<boolean>('autoUploadOnSave', true);

    if (!autoUpload) {
      return;
    }

    const localPath = document.uri.fsPath;
    const mapping = this.fileMappings.get(localPath);

    if (!mapping) {
      return;
    }

    // Debounce uploads
    const debounceMs = config.get<number>('uploadDebounceMs', 500);
    const existingTimer = this.debounceTimers.get(localPath);

    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(localPath);
      await this.uploadFileWithAudit(mapping, document.getText());
    }, debounceMs);

    this.debounceTimers.set(localPath, timer);
  }

  /**
   * Upload a file after save with audit logging
   */
  private async uploadFileWithAudit(mapping: FileMapping, newContent: string): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(mapping.connectionId);

    if (!connection) {
      vscode.window.showWarningMessage(
        `Cannot upload: connection to ${mapping.connectionId} is no longer active`
      );
      return;
    }

    try {
      const content = Buffer.from(newContent, 'utf-8');
      await connection.writeFile(mapping.remotePath, content);

      // Log to audit trail with diff
      const oldContent = mapping.originalContent || '';
      this.auditService.logEdit(
        connection.id,
        connection.host.name,
        connection.host.username,
        mapping.remotePath,
        mapping.localPath,
        oldContent,
        newContent,
        true
      );

      // Update original content for next diff
      mapping.originalContent = newContent;
      mapping.lastSyncTime = Date.now();

      // Show status bar message
      vscode.window.setStatusBarMessage(
        `$(cloud-upload) Uploaded to ${path.basename(mapping.remotePath)}`,
        3000
      );
    } catch (error) {
      // Log failed upload
      this.auditService.logEdit(
        connection.id,
        connection.host.name,
        connection.host.username,
        mapping.remotePath,
        mapping.localPath,
        mapping.originalContent || '',
        newContent,
        false,
        (error as Error).message
      );
      vscode.window.showErrorMessage(`Failed to upload file: ${(error as Error).message}`);
    }
  }

  /**
   * Start global refresh timer for all opened files
   * Prioritizes focused file, then refreshes others
   */
  private startGlobalRefreshTimer(): void {
    const config = vscode.workspace.getConfiguration('sshLite');
    const refreshInterval = config.get<number>('fileRefreshIntervalSeconds', 0);

    if (refreshInterval <= 0) {
      return;
    }

    // Clear existing timer
    if (this.globalRefreshTimer) {
      clearInterval(this.globalRefreshTimer);
    }

    this.globalRefreshTimer = setInterval(async () => {
      await this.refreshOpenedFiles();
    }, refreshInterval * 1000);
  }

  /**
   * Stop global refresh timer
   */
  private stopGlobalRefreshTimer(): void {
    if (this.globalRefreshTimer) {
      clearInterval(this.globalRefreshTimer);
      this.globalRefreshTimer = null;
    }
  }

  /**
   * Refresh all opened files - focused file first, then others
   */
  private async refreshOpenedFiles(): Promise<void> {
    if (this.isRefreshing || this.fileMappings.size === 0) {
      return;
    }

    this.isRefreshing = true;

    try {
      const activeEditor = vscode.window.activeTextEditor;
      const focusedPath = activeEditor?.document.uri.fsPath;

      // Get all file mappings as array
      const mappings = Array.from(this.fileMappings.entries());

      // Find focused file mapping
      const focusedMapping = focusedPath ? mappings.find(([lp]) => lp === focusedPath) : null;

      // Refresh focused file first (high priority)
      if (focusedMapping) {
        await this.refreshSingleFile(focusedMapping[0], focusedMapping[1], true);
      }

      // Refresh other non-focused files
      for (const [localPath, mapping] of mappings) {
        if (localPath !== focusedPath) {
          await this.refreshSingleFile(localPath, mapping, false);
        }
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Refresh a single file from remote
   */
  private async refreshSingleFile(localPath: string, mapping: FileMapping, isFocused: boolean): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(mapping.connectionId);

    if (!connection) {
      return;
    }

    try {
      const content = await connection.readFile(mapping.remotePath);
      const newContent = content.toString('utf-8');

      // Check if content actually changed
      if (newContent !== mapping.originalContent) {
        // Update local file
        fs.writeFileSync(localPath, content);
        mapping.originalContent = newContent;
        mapping.lastSyncTime = Date.now();

        // Refresh the document if it's open in VS Code
        const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
        if (document && !document.isDirty) {
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          );
          edit.replace(document.uri, fullRange, newContent);
          await vscode.workspace.applyEdit(edit);

          if (isFocused) {
            vscode.window.setStatusBarMessage(`$(sync) Auto-refreshed ${path.basename(mapping.remotePath)}`, 2000);
          }
        } else if (document?.isDirty && isFocused) {
          // Only notify for focused file with unsaved changes
          vscode.window.showWarningMessage(
            `Remote file "${path.basename(mapping.remotePath)}" changed. You have unsaved local changes.`,
            'Reload (lose changes)',
            'Keep local'
          ).then(async (action) => {
            if (action === 'Reload (lose changes)') {
              await this.reloadRemoteFile(localPath, mapping, connection);
            }
          });
        }
      }
    } catch {
      // Ignore errors during refresh
    }
  }

  /**
   * Reload a file from remote
   */
  private async reloadRemoteFile(
    localPath: string,
    mapping: FileMapping,
    connection: SSHConnection
  ): Promise<void> {
    try {
      const content = await connection.readFile(mapping.remotePath);
      fs.writeFileSync(localPath, content);
      mapping.originalContent = content.toString('utf-8');
      mapping.lastSyncTime = Date.now();

      // Refresh the document in VS Code
      const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === localPath);
      if (document) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, content.toString('utf-8'));
        await vscode.workspace.applyEdit(edit);
      }

      vscode.window.setStatusBarMessage(`$(sync) Reloaded ${path.basename(mapping.remotePath)}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to reload file: ${(error as Error).message}`);
    }
  }

  /**
   * Show diff between local and remote
   */
  private async showRemoteDiff(
    localPath: string,
    mapping: FileMapping,
    connection: SSHConnection
  ): Promise<void> {
    try {
      const remoteContent = await connection.readFile(mapping.remotePath);
      const remoteTempPath = path.join(
        this.tempDir,
        `remote-${path.basename(mapping.remotePath)}`
      );
      fs.writeFileSync(remoteTempPath, remoteContent);

      const localUri = vscode.Uri.file(localPath);
      const remoteUri = vscode.Uri.file(remoteTempPath);

      await vscode.commands.executeCommand(
        'vscode.diff',
        remoteUri,
        localUri,
        `${path.basename(mapping.remotePath)} (Remote ↔ Local)`
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to show diff: ${(error as Error).message}`);
    }
  }

  /**
   * Open a remote file for editing
   */
  async openRemoteFile(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    // Check file size for large file handling
    if (remoteFile.size >= LARGE_FILE_THRESHOLD) {
      await this.handleLargeFile(connection, remoteFile);
      return;
    }

    // Generate unique temp file path
    const hash = crypto
      .createHash('md5')
      .update(`${connection.id}:${remoteFile.path}`)
      .digest('hex')
      .substring(0, 8);
    const ext = path.extname(remoteFile.name);
    const baseName = path.basename(remoteFile.name, ext);
    const localPath = path.join(this.tempDir, `${baseName}-${hash}${ext}`);

    // Check if already open
    const existingMapping = this.fileMappings.get(localPath);
    if (existingMapping) {
      // Just open the existing file
      const document = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(document);
      return;
    }

    try {
      // Download file
      vscode.window.setStatusBarMessage(`$(cloud-download) Downloading ${remoteFile.name}...`, 5000);
      const content = await connection.readFile(remoteFile.path);
      const contentStr = content.toString('utf-8');

      // Write to temp file
      fs.writeFileSync(localPath, content);

      // Store mapping with original content for audit
      const mapping: FileMapping = {
        connectionId: connection.id,
        remotePath: remoteFile.path,
        localPath,
        lastSyncTime: Date.now(),
        lastRemoteModTime: remoteFile.modifiedTime,
        originalContent: contentStr,
      };
      this.fileMappings.set(localPath, mapping);

      // Log download
      this.auditService.log({
        action: 'download',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        localPath,
        fileSize: remoteFile.size,
        success: true,
      });

      // Open in editor
      const document = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(document);

      vscode.window.setStatusBarMessage(`$(check) Opened ${remoteFile.name}`, 3000);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file: ${(error as Error).message}`);
    }
  }

  /**
   * Handle large file opening with options
   */
  private async handleLargeFile(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    const sizeStr = formatFileSize(remoteFile.size);

    const action = await vscode.window.showQuickPick(
      [
        {
          label: '$(cloud-download) Download in Background',
          description: `Download full file (${sizeStr}) and open when ready`,
          value: 'background',
        },
        {
          label: '$(eye) Preview First Lines',
          description: 'Download first 1000 lines to preview',
          value: 'preview',
        },
        {
          label: '$(file-binary) Download to Disk',
          description: 'Save to local disk without opening',
          value: 'disk',
        },
        {
          label: '$(terminal) View with tail/head',
          description: 'Use remote commands to view portions',
          value: 'remote',
        },
      ],
      {
        placeHolder: `Large file detected (${sizeStr}). How would you like to open it?`,
        ignoreFocusOut: true,
      }
    );

    if (!action) {
      return;
    }

    switch (action.value) {
      case 'background':
        await this.downloadLargeFileBackground(connection, remoteFile);
        break;
      case 'preview':
        await this.previewLargeFile(connection, remoteFile);
        break;
      case 'disk':
        await this.downloadFileTo(connection, remoteFile);
        break;
      case 'remote':
        await this.viewLargeFileRemote(connection, remoteFile);
        break;
    }
  }

  /**
   * Download large file in background with progress
   */
  private async downloadLargeFileBackground(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    const hash = crypto
      .createHash('md5')
      .update(`${connection.id}:${remoteFile.path}`)
      .digest('hex')
      .substring(0, 8);
    const ext = path.extname(remoteFile.name);
    const baseName = path.basename(remoteFile.name, ext);
    const localPath = path.join(this.tempDir, `${baseName}-${hash}${ext}`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${remoteFile.name} (${formatFileSize(remoteFile.size)})...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // For very large files, we could implement chunked download
          // For now, use standard download with progress indication
          progress.report({ increment: 0, message: 'Starting download...' });

          const content = await connection.readFile(remoteFile.path);

          if (token.isCancellationRequested) {
            return;
          }

          progress.report({ increment: 80, message: 'Writing to disk...' });
          fs.writeFileSync(localPath, content);

          const contentStr = content.toString('utf-8');
          const mapping: FileMapping = {
            connectionId: connection.id,
            remotePath: remoteFile.path,
            localPath,
            lastSyncTime: Date.now(),
            lastRemoteModTime: remoteFile.modifiedTime,
            originalContent: contentStr,
          };
          this.fileMappings.set(localPath, mapping);

          progress.report({ increment: 100, message: 'Opening...' });

          const document = await vscode.workspace.openTextDocument(localPath);
          await vscode.window.showTextDocument(document);

          this.auditService.log({
            action: 'download',
            connectionId: connection.id,
            hostName: connection.host.name,
            username: connection.host.username,
            remotePath: remoteFile.path,
            localPath,
            fileSize: remoteFile.size,
            success: true,
          });
        } catch (error) {
          if (!token.isCancellationRequested) {
            vscode.window.showErrorMessage(`Failed to download: ${(error as Error).message}`);
          }
        }
      }
    );
  }

  /**
   * Preview first lines of a large file
   */
  private async previewLargeFile(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    try {
      // Use head command to get first 1000 lines
      const result = await connection.exec(`head -n 1000 "${remoteFile.path}"`);

      // Create a preview document
      const previewPath = path.join(
        this.tempDir,
        `preview-${path.basename(remoteFile.name)}`
      );

      const previewContent =
        `=== PREVIEW: First 1000 lines of ${remoteFile.name} ===\n` +
        `=== Full size: ${formatFileSize(remoteFile.size)} ===\n` +
        `=== Use "Download in Background" for full file ===\n\n` +
        result;

      fs.writeFileSync(previewPath, previewContent);

      const document = await vscode.workspace.openTextDocument(previewPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to preview file: ${(error as Error).message}`);
    }
  }

  /**
   * View large file using remote commands
   */
  private async viewLargeFileRemote(
    connection: SSHConnection,
    remoteFile: IRemoteFile
  ): Promise<void> {
    const command = await vscode.window.showQuickPick(
      [
        { label: 'head -n 100', description: 'First 100 lines', value: `head -n 100 "${remoteFile.path}"` },
        { label: 'head -n 500', description: 'First 500 lines', value: `head -n 500 "${remoteFile.path}"` },
        { label: 'tail -n 100', description: 'Last 100 lines', value: `tail -n 100 "${remoteFile.path}"` },
        { label: 'tail -n 500', description: 'Last 500 lines', value: `tail -n 500 "${remoteFile.path}"` },
        {
          label: 'Custom range',
          description: 'Specify line range',
          value: 'custom',
        },
      ],
      {
        placeHolder: 'Select viewing option',
        ignoreFocusOut: true,
      }
    );

    if (!command) {
      return;
    }

    let cmd = command.value;

    if (cmd === 'custom') {
      const range = await vscode.window.showInputBox({
        prompt: 'Enter line range (e.g., "100,200" for lines 100-200)',
        placeHolder: '100,200',
        ignoreFocusOut: true,
      });

      if (!range) {
        return;
      }

      const [start, end] = range.split(',').map((s) => parseInt(s.trim(), 10));
      if (isNaN(start) || isNaN(end)) {
        vscode.window.showErrorMessage('Invalid range format. Use "start,end" format.');
        return;
      }

      cmd = `sed -n '${start},${end}p' "${remoteFile.path}"`;
    }

    try {
      const result = await connection.exec(cmd);

      const viewPath = path.join(this.tempDir, `view-${path.basename(remoteFile.name)}`);
      fs.writeFileSync(viewPath, result);

      const document = await vscode.workspace.openTextDocument(viewPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to view file: ${(error as Error).message}`);
    }
  }

  /**
   * Download a file to a user-selected location
   */
  async downloadFileTo(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    const defaultUri = vscode.Uri.file(path.join(os.homedir(), remoteFile.name));

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'All Files': ['*'],
      },
    });

    if (!saveUri) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${remoteFile.name}...`,
          cancellable: false,
        },
        async () => {
          const content = await connection.readFile(remoteFile.path);
          fs.writeFileSync(saveUri.fsPath, content);
        }
      );

      this.auditService.log({
        action: 'download',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        localPath: saveUri.fsPath,
        fileSize: remoteFile.size,
        success: true,
      });

      vscode.window.showInformationMessage(`Downloaded ${remoteFile.name} successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to download file: ${(error as Error).message}`);
    }
  }

  /**
   * Download a folder recursively
   */
  async downloadFolder(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
    const folderUri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Download Location',
    });

    if (!folderUri || folderUri.length === 0) {
      return;
    }

    const targetDir = path.join(folderUri[0].fsPath, remoteFile.name);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${remoteFile.name}...`,
          cancellable: false,
        },
        async (progress) => {
          await this.downloadFolderRecursive(connection, remoteFile.path, targetDir, progress);
        }
      );

      vscode.window.showInformationMessage(`Downloaded ${remoteFile.name} successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to download folder: ${(error as Error).message}`);
    }
  }

  /**
   * Recursively download a folder
   */
  private async downloadFolderRecursive(
    connection: SSHConnection,
    remotePath: string,
    localPath: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    // Create local directory
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
    }

    // List remote directory
    const files = await connection.listFiles(remotePath);

    for (const file of files) {
      const localFilePath = path.join(localPath, file.name);
      progress.report({ message: file.name });

      if (file.isDirectory) {
        await this.downloadFolderRecursive(connection, file.path, localFilePath, progress);
      } else {
        const content = await connection.readFile(file.path);
        fs.writeFileSync(localFilePath, content);
      }
    }
  }

  /**
   * Upload a file from local to remote
   */
  async uploadFileTo(connection: SSHConnection, remoteFolderPath: string): Promise<void> {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: 'Select File to Upload',
    });

    if (!fileUri || fileUri.length === 0) {
      return;
    }

    const localPath = fileUri[0].fsPath;
    const fileName = path.basename(localPath);
    const remotePath = `${remoteFolderPath}/${fileName}`;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uploading ${fileName}...`,
          cancellable: false,
        },
        async () => {
          const content = fs.readFileSync(localPath);
          await connection.writeFile(remotePath, content);
        }
      );

      this.auditService.log({
        action: 'upload',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath,
        localPath,
        fileSize: fs.statSync(localPath).size,
        success: true,
      });

      vscode.window.showInformationMessage(`Uploaded ${fileName} successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to upload file: ${(error as Error).message}`);
    }
  }

  /**
   * Delete a remote file or folder
   */
  async deleteRemote(connection: SSHConnection, remoteFile: IRemoteFile): Promise<boolean> {
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${remoteFile.name}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return false;
    }

    try {
      if (remoteFile.isDirectory) {
        // Delete directory contents recursively
        await this.deleteDirectoryRecursive(connection, remoteFile.path);
      } else {
        await connection.deleteFile(remoteFile.path);
      }

      this.auditService.log({
        action: 'delete',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        fileSize: remoteFile.size,
        success: true,
      });

      vscode.window.showInformationMessage(`Deleted ${remoteFile.name} successfully`);
      return true;
    } catch (error) {
      this.auditService.log({
        action: 'delete',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath: remoteFile.path,
        success: false,
        error: (error as Error).message,
      });
      vscode.window.showErrorMessage(`Failed to delete: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Recursively delete a directory
   */
  private async deleteDirectoryRecursive(connection: SSHConnection, remotePath: string): Promise<void> {
    const files = await connection.listFiles(remotePath);

    for (const file of files) {
      if (file.isDirectory) {
        await this.deleteDirectoryRecursive(connection, file.path);
      } else {
        await connection.deleteFile(file.path);
      }
    }

    await connection.deleteFile(remotePath);
  }

  /**
   * Create a new folder
   */
  async createFolder(connection: SSHConnection, parentPath: string): Promise<string | undefined> {
    const folderName = await vscode.window.showInputBox({
      prompt: 'Enter folder name',
      placeHolder: 'new-folder',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Folder name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Folder name cannot contain slashes';
        }
        return null;
      },
    });

    if (!folderName) {
      return undefined;
    }

    const remotePath = `${parentPath}/${folderName}`;

    try {
      await connection.mkdir(remotePath);

      this.auditService.log({
        action: 'mkdir',
        connectionId: connection.id,
        hostName: connection.host.name,
        username: connection.host.username,
        remotePath,
        success: true,
      });

      vscode.window.showInformationMessage(`Created folder ${folderName}`);
      return remotePath;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create folder: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Get all open file mappings
   */
  getOpenFiles(): FileMapping[] {
    return Array.from(this.fileMappings.values());
  }

  /**
   * Clean up temp files for a connection
   */
  cleanupConnection(connectionId: string): void {
    for (const [localPath, mapping] of this.fileMappings) {
      if (mapping.connectionId === connectionId) {
        // Clear any pending debounce timer
        const timer = this.debounceTimers.get(localPath);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(localPath);
        }


        // Try to delete the temp file
        try {
          if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
          }
        } catch {
          // Ignore errors during cleanup
        }
        this.fileMappings.delete(localPath);
      }
    }
  }

  /**
   * Clean up all temp files
   */
  cleanupAll(): void {
    for (const [localPath] of this.fileMappings) {
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.fileMappings.clear();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.cleanupAll();
    this.stopGlobalRefreshTimer();

    if (this.saveListenerDisposable) {
      this.saveListenerDisposable.dispose();
    }

    if (this.configChangeListener) {
      this.configChangeListener.dispose();
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
