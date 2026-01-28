import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Audit action types
 */
export type AuditAction = 'create' | 'edit' | 'delete' | 'download' | 'upload' | 'mkdir' | 'rename' | 'move';

/**
 * Audit log entry
 */
export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  connectionId: string;
  hostName: string;
  username: string;
  remotePath: string;
  localPath?: string;
  fileSize?: number;
  bytesChanged?: number;
  diff?: string;
  success: boolean;
  error?: string;
}

/**
 * Service for audit trail logging
 * Logs to both local JSON file and VS Code Output Channel
 */
export class AuditService {
  private static _instance: AuditService;
  private outputChannel: vscode.OutputChannel;
  private logFilePath: string;
  private entries: AuditEntry[] = [];
  private maxEntries: number = 1000;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('SSH Lite Audit');
    this.logFilePath = this.getLogFilePath();
    this.loadExistingLogs();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): AuditService {
    if (!AuditService._instance) {
      AuditService._instance = new AuditService();
    }
    return AuditService._instance;
  }

  /**
   * Get log file path
   */
  private getLogFilePath(): string {
    const config = vscode.workspace.getConfiguration('sshLite');
    const customPath = config.get<string>('auditLogPath', '');

    if (customPath) {
      return customPath;
    }

    // Default to extension storage or workspace
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const vscodePath = path.join(workspaceFolder.uri.fsPath, '.vscode');
      if (!fs.existsSync(vscodePath)) {
        fs.mkdirSync(vscodePath, { recursive: true });
      }
      return path.join(vscodePath, 'ssh-lite-audit.json');
    }

    // Fallback to home directory
    const sshLitePath = path.join(os.homedir(), '.ssh-lite');
    if (!fs.existsSync(sshLitePath)) {
      fs.mkdirSync(sshLitePath, { recursive: true });
    }
    return path.join(sshLitePath, 'audit.json');
  }

  /**
   * Load existing logs from file
   */
  private loadExistingLogs(): void {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const content = fs.readFileSync(this.logFilePath, 'utf-8');
        this.entries = JSON.parse(content);
      }
    } catch (error) {
      console.error('Failed to load audit logs:', error);
      this.entries = [];
    }
  }

  /**
   * Save logs to file
   */
  private saveLogs(): void {
    try {
      // Trim to max entries
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }

      fs.writeFileSync(this.logFilePath, JSON.stringify(this.entries, null, 2));
    } catch (error) {
      console.error('Failed to save audit logs:', error);
    }
  }

  /**
   * Generate a simple diff between two strings
   */
  generateDiff(oldContent: string, newContent: string): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const diff: string[] = [];
    const maxLines = Math.max(oldLines.length, newLines.length);

    // Simple line-by-line diff
    let addedLines = 0;
    let removedLines = 0;
    let changedLines = 0;

    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine === undefined && newLine !== undefined) {
        diff.push(`+${i + 1}: ${newLine}`);
        addedLines++;
      } else if (oldLine !== undefined && newLine === undefined) {
        diff.push(`-${i + 1}: ${oldLine}`);
        removedLines++;
      } else if (oldLine !== newLine) {
        diff.push(`-${i + 1}: ${oldLine}`);
        diff.push(`+${i + 1}: ${newLine}`);
        changedLines++;
      }
    }

    // Add summary
    const summary = `--- Summary: +${addedLines} added, -${removedLines} removed, ~${changedLines} changed ---`;

    return [summary, ...diff].join('\n');
  }

  /**
   * Log an audit entry
   */
  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    // Add to in-memory list
    this.entries.push(fullEntry);

    // Log to output channel
    this.logToOutputChannel(fullEntry);

    // Save to file
    this.saveLogs();
  }

  /**
   * Log a file edit with diff
   */
  logEdit(
    connectionId: string,
    hostName: string,
    username: string,
    remotePath: string,
    localPath: string,
    oldContent: string,
    newContent: string,
    success: boolean,
    error?: string
  ): void {
    const diff = this.generateDiff(oldContent, newContent);
    const bytesChanged = Math.abs(newContent.length - oldContent.length);

    this.log({
      action: 'edit',
      connectionId,
      hostName,
      username,
      remotePath,
      localPath,
      fileSize: newContent.length,
      bytesChanged,
      diff,
      success,
      error,
    });
  }

  /**
   * Log to VS Code output channel
   */
  private logToOutputChannel(entry: AuditEntry): void {
    const lines = [
      `[${entry.timestamp}] ${entry.action.toUpperCase()} - ${entry.success ? 'SUCCESS' : 'FAILED'}`,
      `  Host: ${entry.hostName} (${entry.username})`,
      `  Path: ${entry.remotePath}`,
    ];

    if (entry.localPath) {
      lines.push(`  Local: ${entry.localPath}`);
    }

    if (entry.fileSize !== undefined) {
      lines.push(`  Size: ${entry.fileSize} bytes`);
    }

    if (entry.bytesChanged !== undefined) {
      lines.push(`  Changed: ${entry.bytesChanged} bytes`);
    }

    if (entry.error) {
      lines.push(`  Error: ${entry.error}`);
    }

    if (entry.diff) {
      lines.push('  Diff:');
      entry.diff.split('\n').forEach((line) => {
        lines.push(`    ${line}`);
      });
    }

    lines.push(''); // Empty line separator

    this.outputChannel.appendLine(lines.join('\n'));
  }

  /**
   * Show audit log in output channel
   */
  showLog(): void {
    this.outputChannel.show();
  }

  /**
   * Get recent entries
   */
  getRecentEntries(count: number = 50): AuditEntry[] {
    return this.entries.slice(-count);
  }

  /**
   * Get entries for a specific file
   */
  getEntriesForFile(remotePath: string): AuditEntry[] {
    return this.entries.filter((e) => e.remotePath === remotePath);
  }

  /**
   * Get entries for a specific connection
   */
  getEntriesForConnection(connectionId: string): AuditEntry[] {
    return this.entries.filter((e) => e.connectionId === connectionId);
  }

  /**
   * Export logs to a file
   */
  async exportLogs(targetPath?: string): Promise<string> {
    const exportPath =
      targetPath ||
      (await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'ssh-lite-audit-export.json')),
        filters: { 'JSON Files': ['json'] },
      }));

    if (!exportPath) {
      throw new Error('No export path selected');
    }

    const exportPathStr = typeof exportPath === 'string' ? exportPath : exportPath.fsPath;
    fs.writeFileSync(exportPathStr, JSON.stringify(this.entries, null, 2));

    return exportPathStr;
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.entries = [];
    this.saveLogs();
    this.outputChannel.clear();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.outputChannel.dispose();
  }
}
