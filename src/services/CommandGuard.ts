/*
 * Copyright 2026 SSH Lite Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { ClientChannel } from 'ssh2';
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { ActivityService, ActivityType } from './ActivityService';
import { formatFileSize } from '../utils/helpers';
import { ChannelSemaphore, ChannelLimitError, ChannelTimeoutError } from './ChannelSemaphore';
import { diagLog, infoLog } from '../utils/diagnosticLog';

/**
 * Options for tracked operations
 */
export interface TrackingOptions {
  /** Activity description shown in Activity panel */
  description?: string;
  /** Additional detail text */
  detail?: string;
  /** Activity type override */
  type?: ActivityType;
  /** Whether the operation can be cancelled */
  cancellable?: boolean;
  /** Callback when operation is cancelled */
  onCancel?: () => void;
}

/**
 * CommandGuard - Man in the middle for all SSH operations
 *
 * All data transfer between local and server should go through this guard.
 * This provides:
 * - Unified activity tracking
 * - Centralized monitoring
 * - Cancellation support
 * - Progress reporting
 *
 * LITE Principle: Only significant user-initiated operations are tracked.
 * Quick metadata lookups (stat, realpath) are NOT tracked to avoid noise.
 */
export class CommandGuard {
  private static _instance: CommandGuard;
  private activityService: ActivityService;
  private semaphores: Map<string, ChannelSemaphore> = new Map();
  private static readonly EXEC_MAX_RETRIES = 3;
  private static readonly EXEC_RETRY_DELAY_MS = 100;
  private static readonly SHELL_TIMEOUT_MS = 30_000;

  private constructor() {
    this.activityService = ActivityService.getInstance();
  }

  static getInstance(): CommandGuard {
    if (!CommandGuard._instance) {
      CommandGuard._instance = new CommandGuard();
    }
    return CommandGuard._instance;
  }

  private getSemaphore(connectionId: string): ChannelSemaphore {
    if (!this.semaphores.has(connectionId)) {
      const config = vscode.workspace.getConfiguration('sshLite');
      const maxSlots = config.get<number>('maxChannelsPerServer', 8);
      infoLog('command-guard', 'create-semaphore', { connectionId, maxSlots });
      this.semaphores.set(connectionId, new ChannelSemaphore(maxSlots, connectionId));
    }
    return this.semaphores.get(connectionId)!;
  }

  removeSemaphore(connectionId: string): void {
    const sem = this.semaphores.get(connectionId);
    if (sem) {
      infoLog('command-guard', 'remove-semaphore', {
        connectionId,
        active: sem.activeCount,
        queued: sem.queued,
        max: sem.maxSlots,
      });
      sem.destroy(new Error('Connection closed'));
      this.semaphores.delete(connectionId);
    }
  }

  /**
   * Open an interactive shell channel with activity tracking and semaphore slot management.
   * The acquired slot is held until the channel emits 'close' or 'exit'.
   * Times out after SHELL_TIMEOUT_MS (30 s) if no slot is available.
   *
   * Note: connection.shell() is SSHConnection.shell() - opens a remote interactive shell,
   * NOT a local shell. No local injection risk.
   */
  async openShell(
    connection: SSHConnection,
    pty?: { term?: string; rows?: number; cols?: number },
    opts?: { env?: Record<string, string> }
  ): Promise<ClientChannel> {
    const semaphore = this.getSemaphore(connection.id);
    const acquireStart = Date.now();
    diagLog('command-guard', 'openShell/begin', {
      connectionId: connection.id,
      timeoutMs: CommandGuard.SHELL_TIMEOUT_MS,
    });
    let release: () => void;
    try {
      release = await semaphore.acquire(CommandGuard.SHELL_TIMEOUT_MS);
    } catch (err) {
      const e = err as Error;
      infoLog('command-guard', 'openShell/acquire-failed', {
        connectionId: connection.id,
        waitedMs: Date.now() - acquireStart,
        errorName: e.name,
        errorMessage: e.message,
      });
      throw err;
    }
    diagLog('command-guard', 'openShell/slot-acquired', {
      connectionId: connection.id,
      waitedMs: Date.now() - acquireStart,
    });

    let channel: ClientChannel;
    const shellStart = Date.now();
    try {
      channel = await connection.shell(pty, opts);
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'openShell/shell-failed', {
        connectionId: connection.id,
        durationMs: Date.now() - shellStart,
        errorName: e.name,
        errorMessage: e.message,
      });
      release();
      throw error;
    }
    diagLog('command-guard', 'openShell/ready', {
      connectionId: connection.id,
      shellMs: Date.now() - shellStart,
      totalMs: Date.now() - acquireStart,
    });

    let released = false;
    const releaseOnce = (event: string) => () => {
      if (!released) {
        released = true;
        diagLog('command-guard', 'openShell/release', {
          connectionId: connection.id,
          via: event,
        });
        release();
      }
    };
    channel.on('close', releaseOnce('close'));
    channel.on('exit', releaseOnce('exit'));

    return channel;
  }

  /**
   * Execute a shell command with activity tracking and channel semaphore protection.
   * Automatically retries up to EXEC_MAX_RETRIES times on SSH "open failure" errors.
   * Use for significant commands (search, find, etc.)
   *
   * Note: connection.exec() is SSHConnection.exec() - remote SSH command execution,
   * NOT local child_process. No local shell injection risk.
   */
  async exec(
    connection: SSHConnection,
    command: string,
    options?: TrackingOptions
  ): Promise<string> {
    const desc = options?.description || this.extractCommandDescription(command);
    const activityId = this.activityService.startActivity(
      options?.type || 'terminal',
      connection.id,
      connection.host.name,
      desc,
      {
        detail: options?.detail,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const semaphore = this.getSemaphore(connection.id);
    let lastError: Error | undefined;
    const cmdPreview = command.length > 80 ? command.slice(0, 80) + '…' : command;
    const execStart = Date.now();
    diagLog('command-guard', 'exec/begin', {
      connectionId: connection.id,
      cmd: cmdPreview,
      sudo: !!(connection.sudoMode && connection.sudoPassword),
    });

    for (let attempt = 0; attempt <= CommandGuard.EXEC_MAX_RETRIES; attempt++) {
      let release: (() => void) | undefined;
      const attemptStart = Date.now();
      try {
        release = await semaphore.acquire();
        let result: string;
        if (connection.sudoMode && connection.sudoPassword) {
          result = await connection.sudoExec(command, connection.sudoPassword);
        } else {
          result = await connection.exec(command);
        }
        semaphore.recordSuccess();
        this.activityService.completeActivity(activityId);
        diagLog('command-guard', 'exec/success', {
          connectionId: connection.id,
          attempt,
          attemptMs: Date.now() - attemptStart,
          totalMs: Date.now() - execStart,
          bytes: result.length,
        });
        return result;
      } catch (error) {
        const err = error as Error;
        if (err.message?.includes('open failure')) {
          semaphore.reduceMax();
          lastError = new ChannelLimitError();
          infoLog('command-guard', 'exec/channel-limit-retry', {
            connectionId: connection.id,
            attempt,
            maxRetries: CommandGuard.EXEC_MAX_RETRIES,
            attemptMs: Date.now() - attemptStart,
            cmd: cmdPreview,
            originalError: err.message,
            newMaxSlots: semaphore.maxSlots,
          });
          if (attempt < CommandGuard.EXEC_MAX_RETRIES) {
            await new Promise<void>(r => setTimeout(r, CommandGuard.EXEC_RETRY_DELAY_MS));
          }
          // continue to next attempt or fall through to post-loop throw
        } else {
          infoLog('command-guard', 'exec/failed', {
            connectionId: connection.id,
            attempt,
            attemptMs: Date.now() - attemptStart,
            totalMs: Date.now() - execStart,
            cmd: cmdPreview,
            errorName: err.name,
            errorMessage: err.message,
            isTimeout: err instanceof ChannelTimeoutError,
          });
          this.activityService.failActivity(activityId, err.message);
          throw error;
        }
      } finally {
        release?.();
      }
    }

    infoLog('command-guard', 'exec/exhausted', {
      connectionId: connection.id,
      attempts: CommandGuard.EXEC_MAX_RETRIES + 1,
      totalMs: Date.now() - execStart,
      cmd: cmdPreview,
      finalMaxSlots: semaphore.maxSlots,
      lastError: lastError!.message,
    });
    this.activityService.failActivity(activityId, lastError!.message);
    throw lastError!;
  }

  /**
   * Read a remote file with activity tracking.
   * Automatically routes through sudo when connection sudo mode is active.
   */
  async readFile(
    connection: SSHConnection,
    remotePath: string,
    options?: TrackingOptions
  ): Promise<Buffer> {
    const fileName = path.basename(remotePath);
    const sudoPrefix = connection.sudoMode ? 'Sudo ' : '';
    const activityId = this.activityService.startActivity(
      options?.type || 'download',
      connection.id,
      connection.host.name,
      options?.description || `${sudoPrefix}Download: ${fileName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'readFile/begin', { connectionId: connection.id, remotePath, sudo: !!(connection.sudoMode && connection.sudoPassword) });
    try {
      let result: Buffer;
      if (connection.sudoMode && connection.sudoPassword) {
        result = await connection.sudoReadFile(remotePath, connection.sudoPassword);
      } else {
        result = await connection.readFile(remotePath);
      }
      this.activityService.completeActivity(activityId, formatFileSize(result.length));
      diagLog('command-guard', 'readFile/success', { connectionId: connection.id, remotePath, bytes: result.length, durationMs: Date.now() - t0 });
      return result;
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'readFile/failed', { connectionId: connection.id, remotePath, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Write a remote file with activity tracking.
   * Automatically routes through sudo when connection sudo mode is active.
   */
  async writeFile(
    connection: SSHConnection,
    remotePath: string,
    content: Buffer | string,
    options?: TrackingOptions
  ): Promise<void> {
    const fileName = path.basename(remotePath);
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
    const sudoPrefix = connection.sudoMode ? 'Sudo ' : '';
    const activityId = this.activityService.startActivity(
      options?.type || 'upload',
      connection.id,
      connection.host.name,
      options?.description || `${sudoPrefix}Upload: ${fileName}`,
      {
        detail: options?.detail || `${formatFileSize(size)} to ${remotePath}`,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'writeFile/begin', { connectionId: connection.id, remotePath, bytes: size, sudo: !!(connection.sudoMode && connection.sudoPassword) });
    try {
      const buffer = typeof content === 'string' ? Buffer.from(content) : content;
      if (connection.sudoMode && connection.sudoPassword) {
        await connection.sudoWriteFile(remotePath, buffer, connection.sudoPassword);
      } else {
        await connection.writeFile(remotePath, buffer);
      }
      this.activityService.completeActivity(activityId, formatFileSize(size));
      diagLog('command-guard', 'writeFile/success', { connectionId: connection.id, remotePath, bytes: size, durationMs: Date.now() - t0 });
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'writeFile/failed', { connectionId: connection.id, remotePath, bytes: size, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * List directory contents with activity tracking.
   * Automatically routes through sudo when connection sudo mode is active.
   */
  async listFiles(
    connection: SSHConnection,
    remotePath: string,
    options?: TrackingOptions
  ): Promise<IRemoteFile[]> {
    const folderName = remotePath === '~' ? 'Home' : path.basename(remotePath) || '/';
    const sudoPrefix = connection.sudoMode ? 'Sudo ' : '';
    const activityId = this.activityService.startActivity(
      options?.type || 'directory-load',
      connection.id,
      connection.host.name,
      options?.description || `${sudoPrefix}List: ${folderName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'listFiles/begin', { connectionId: connection.id, remotePath, sudo: !!(connection.sudoMode && connection.sudoPassword) });
    try {
      let result: IRemoteFile[];
      if (connection.sudoMode && connection.sudoPassword) {
        result = await connection.sudoListFiles(remotePath, connection.sudoPassword);
      } else {
        result = await connection.listFiles(remotePath);
      }
      this.activityService.completeActivity(activityId, `${result.length} items`);
      diagLog('command-guard', 'listFiles/success', { connectionId: connection.id, remotePath, count: result.length, durationMs: Date.now() - t0 });
      return result;
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'listFiles/failed', { connectionId: connection.id, remotePath, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Search files with activity tracking
   */
  async searchFiles(
    connection: SSHConnection,
    searchPath: string,
    pattern: string,
    searchOptions: {
      searchContent?: boolean;
      caseSensitive?: boolean;
      filePattern?: string;
      maxResults?: number;
      nativeTools?: 'auto' | 'off';
    },
    trackOptions?: TrackingOptions
  ): Promise<Array<{ path: string; line?: number; preview?: string }>> {
    const activityId = this.activityService.startActivity(
      trackOptions?.type || 'search',
      connection.id,
      connection.host.name,
      trackOptions?.description || `Search: "${pattern.substring(0, 30)}${pattern.length > 30 ? '...' : ''}"`,
      {
        detail: trackOptions?.detail || `in ${searchPath}`,
        cancellable: trackOptions?.cancellable,
        onCancel: trackOptions?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'searchFiles/begin', { connectionId: connection.id, searchPath, pattern: pattern.length > 80 ? pattern.slice(0, 80) + '…' : pattern, searchContent: !!searchOptions.searchContent, caseSensitive: !!searchOptions.caseSensitive, filePattern: searchOptions.filePattern, maxResults: searchOptions.maxResults });
    try {
      const result = await connection.searchFiles(searchPath, pattern, searchOptions);
      this.activityService.completeActivity(activityId, `${result.length} results`);
      diagLog('command-guard', 'searchFiles/success', { connectionId: connection.id, searchPath, count: result.length, durationMs: Date.now() - t0 });
      return result;
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'searchFiles/failed', { connectionId: connection.id, searchPath, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Start file monitoring with activity tracking
   * Returns the activity ID for later updates
   */
  startMonitoring(
    connection: SSHConnection,
    remotePath: string,
    options?: TrackingOptions
  ): string {
    const fileName = path.basename(remotePath);
    return this.activityService.startActivity(
      'monitor',
      connection.id,
      connection.host.name,
      options?.description || `Watch: ${fileName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: true,
        onCancel: options?.onCancel,
      }
    );
  }

  /**
   * Update monitoring activity status
   */
  updateMonitoring(activityId: string, detail: string): void {
    this.activityService.updateDetail(activityId, detail);
  }

  /**
   * Stop monitoring activity
   */
  stopMonitoring(activityId: string, reason?: string): void {
    if (reason === 'cancelled') {
      this.activityService.cancelActivity(activityId);
    } else {
      this.activityService.completeActivity(activityId, reason || 'Stopped');
    }
  }

  /**
   * Start a file refresh operation with activity tracking
   * Returns the activity ID for progress updates
   */
  startRefresh(
    connection: SSHConnection,
    remotePath: string,
    options?: TrackingOptions
  ): string {
    const fileName = path.basename(remotePath);
    return this.activityService.startActivity(
      'file-refresh',
      connection.id,
      connection.host.name,
      options?.description || `Refresh: ${fileName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );
  }

  /**
   * Complete a refresh operation
   */
  completeRefresh(activityId: string, detail?: string): void {
    this.activityService.completeActivity(activityId, detail);
  }

  /**
   * Fail a refresh operation
   */
  failRefresh(activityId: string, error: string): void {
    this.activityService.failActivity(activityId, error);
  }

  /**
   * Start a connection activity
   */
  startConnect(hostName: string, connectionId: string): string {
    return this.activityService.startActivity(
      'connect',
      connectionId,
      hostName,
      `Connecting to ${hostName}`,
      { cancellable: false }
    );
  }

  /**
   * Complete connection activity
   */
  completeConnect(activityId: string): void {
    this.activityService.completeActivity(activityId, 'Connected');
  }

  /**
   * Fail connection activity
   */
  failConnect(activityId: string, error: string): void {
    this.activityService.failActivity(activityId, error);
  }

  /**
   * Track a disconnect
   */
  trackDisconnect(connection: SSHConnection): void {
    const activityId = this.activityService.startActivity(
      'disconnect',
      connection.id,
      connection.host.name,
      `Disconnect: ${connection.host.name}`,
      { cancellable: false }
    );
    this.activityService.completeActivity(activityId, 'Disconnected');
  }

  // --- Explicit one-off sudo wrappers (per-action fallback) ---

  /**
   * Write a remote file using sudo (one-off, not connection-wide)
   */
  async sudoWriteFile(
    connection: SSHConnection,
    remotePath: string,
    content: Buffer,
    password: string,
    options?: TrackingOptions
  ): Promise<void> {
    const fileName = path.basename(remotePath);
    const size = content.length;
    const activityId = this.activityService.startActivity(
      options?.type || 'upload',
      connection.id,
      connection.host.name,
      options?.description || `Sudo Save: ${fileName}`,
      {
        detail: options?.detail || `${formatFileSize(size)} to ${remotePath}`,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'sudoWriteFile/begin', { connectionId: connection.id, remotePath, bytes: size });
    try {
      await connection.sudoWriteFile(remotePath, content, password);
      this.activityService.completeActivity(activityId, formatFileSize(size));
      diagLog('command-guard', 'sudoWriteFile/success', { connectionId: connection.id, remotePath, bytes: size, durationMs: Date.now() - t0 });
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'sudoWriteFile/failed', { connectionId: connection.id, remotePath, bytes: size, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Read a remote file using sudo (one-off)
   */
  async sudoReadFile(
    connection: SSHConnection,
    remotePath: string,
    password: string,
    options?: TrackingOptions
  ): Promise<Buffer> {
    const fileName = path.basename(remotePath);
    const activityId = this.activityService.startActivity(
      options?.type || 'download',
      connection.id,
      connection.host.name,
      options?.description || `Sudo Read: ${fileName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'sudoReadFile/begin', { connectionId: connection.id, remotePath });
    try {
      const result = await connection.sudoReadFile(remotePath, password);
      this.activityService.completeActivity(activityId, formatFileSize(result.length));
      diagLog('command-guard', 'sudoReadFile/success', { connectionId: connection.id, remotePath, bytes: result.length, durationMs: Date.now() - t0 });
      return result;
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'sudoReadFile/failed', { connectionId: connection.id, remotePath, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Delete a remote file/directory using sudo (one-off)
   */
  async sudoDeleteFile(
    connection: SSHConnection,
    remotePath: string,
    password: string,
    isDirectory: boolean = false,
    options?: TrackingOptions
  ): Promise<void> {
    const fileName = path.basename(remotePath);
    const activityId = this.activityService.startActivity(
      options?.type || 'upload',
      connection.id,
      connection.host.name,
      options?.description || `Sudo Delete: ${fileName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'sudoDeleteFile/begin', { connectionId: connection.id, remotePath, isDirectory });
    try {
      await connection.sudoDeleteFile(remotePath, password, isDirectory);
      this.activityService.completeActivity(activityId, 'Deleted');
      diagLog('command-guard', 'sudoDeleteFile/success', { connectionId: connection.id, remotePath, isDirectory, durationMs: Date.now() - t0 });
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'sudoDeleteFile/failed', { connectionId: connection.id, remotePath, isDirectory, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Create a directory using sudo (one-off)
   */
  async sudoMkdir(
    connection: SSHConnection,
    remotePath: string,
    password: string,
    options?: TrackingOptions
  ): Promise<void> {
    const folderName = path.basename(remotePath);
    const activityId = this.activityService.startActivity(
      options?.type || 'directory-load',
      connection.id,
      connection.host.name,
      options?.description || `Sudo Mkdir: ${folderName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'sudoMkdir/begin', { connectionId: connection.id, remotePath });
    try {
      await connection.sudoMkdir(remotePath, password);
      this.activityService.completeActivity(activityId, 'Created');
      diagLog('command-guard', 'sudoMkdir/success', { connectionId: connection.id, remotePath, durationMs: Date.now() - t0 });
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'sudoMkdir/failed', { connectionId: connection.id, remotePath, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Rename/move using sudo (one-off)
   */
  async sudoRename(
    connection: SSHConnection,
    oldPath: string,
    newPath: string,
    password: string,
    options?: TrackingOptions
  ): Promise<void> {
    const fileName = path.basename(oldPath);
    const activityId = this.activityService.startActivity(
      options?.type || 'upload',
      connection.id,
      connection.host.name,
      options?.description || `Sudo Rename: ${fileName}`,
      {
        detail: options?.detail || `${oldPath} -> ${newPath}`,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const t0 = Date.now();
    diagLog('command-guard', 'sudoRename/begin', { connectionId: connection.id, oldPath, newPath });
    try {
      await connection.sudoRename(oldPath, newPath, password);
      this.activityService.completeActivity(activityId, 'Renamed');
      diagLog('command-guard', 'sudoRename/success', { connectionId: connection.id, oldPath, newPath, durationMs: Date.now() - t0 });
    } catch (error) {
      const e = error as Error;
      infoLog('command-guard', 'sudoRename/failed', { connectionId: connection.id, oldPath, newPath, durationMs: Date.now() - t0, errorName: e.name, errorMessage: e.message });
      this.activityService.failActivity(activityId, e.message);
      throw error;
    }
  }

  /**
   * Extract a human-readable description from a shell command
   */
  private extractCommandDescription(command: string): string {
    // Truncate long commands
    const maxLen = 50;
    const cmd = command.trim();

    // Try to identify common command patterns
    if (cmd.startsWith('grep ')) {
      return `Search content`;
    }
    if (cmd.startsWith('find ')) {
      return `Find files`;
    }
    if (cmd.startsWith('ls ')) {
      return `List directory`;
    }
    if (cmd.startsWith('cat ')) {
      return `Read file`;
    }
    if (cmd.startsWith('tail ')) {
      return `Read file tail`;
    }
    if (cmd.startsWith('head ')) {
      return `Read file head`;
    }

    // Default: truncated command
    if (cmd.length > maxLen) {
      return `${cmd.substring(0, maxLen)}...`;
    }
    return cmd;
  }
}