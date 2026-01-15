import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';

/**
 * Mapping from local temp file to remote file info
 */
interface FileMapping {
  connectionId: string;
  remotePath: string;
  localPath: string;
  lastSyncTime: number;
}

/**
 * Service for file operations and auto-sync
 */
export class FileService {
  private static _instance: FileService;

  private tempDir: string;
  private fileMappings: Map<string, FileMapping> = new Map(); // localPath -> mapping
  private saveListenerDisposable: vscode.Disposable | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  private constructor() {
    this.tempDir = path.join(os.tmpdir(), 'ssh-lite');
    this.ensureTempDir();
    this.setupSaveListener();
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
      await this.uploadFile(mapping);
    }, debounceMs);

    this.debounceTimers.set(localPath, timer);
  }

  /**
   * Upload a file after save
   */
  private async uploadFile(mapping: FileMapping): Promise<void> {
    const connectionManager = ConnectionManager.getInstance();
    const connection = connectionManager.getConnection(mapping.connectionId);

    if (!connection) {
      vscode.window.showWarningMessage(
        `Cannot upload: connection to ${mapping.connectionId} is no longer active`
      );
      return;
    }

    try {
      const content = fs.readFileSync(mapping.localPath);
      await connection.writeFile(mapping.remotePath, content);

      mapping.lastSyncTime = Date.now();

      // Show status bar message
      vscode.window.setStatusBarMessage(
        `$(cloud-upload) Uploaded to ${path.basename(mapping.remotePath)}`,
        3000
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to upload file: ${(error as Error).message}`);
    }
  }

  /**
   * Open a remote file for editing
   */
  async openRemoteFile(connection: SSHConnection, remoteFile: IRemoteFile): Promise<void> {
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

      // Write to temp file
      fs.writeFileSync(localPath, content);

      // Store mapping
      this.fileMappings.set(localPath, {
        connectionId: connection.id,
        remotePath: remoteFile.path,
        localPath,
        lastSyncTime: Date.now(),
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

      vscode.window.showInformationMessage(`Deleted ${remoteFile.name} successfully`);
      return true;
    } catch (error) {
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
      vscode.window.showInformationMessage(`Created folder ${folderName}`);
      return remotePath;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create folder: ${(error as Error).message}`);
      return undefined;
    }
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

    if (this.saveListenerDisposable) {
      this.saveListenerDisposable.dispose();
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
