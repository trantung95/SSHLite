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
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile } from '../types';
import { ActivityService, ActivityType } from './ActivityService';
import { formatFileSize } from '../utils/helpers';

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

  private constructor() {
    this.activityService = ActivityService.getInstance();
  }

  static getInstance(): CommandGuard {
    if (!CommandGuard._instance) {
      CommandGuard._instance = new CommandGuard();
    }
    return CommandGuard._instance;
  }

  /**
   * Execute a shell command with activity tracking
   * Use for significant commands (search, find, etc.)
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

    try {
      const result = await connection.exec(command);
      this.activityService.completeActivity(activityId);
      return result;
    } catch (error) {
      this.activityService.failActivity(activityId, (error as Error).message);
      throw error;
    }
  }

  /**
   * Read a remote file with activity tracking
   */
  async readFile(
    connection: SSHConnection,
    remotePath: string,
    options?: TrackingOptions
  ): Promise<Buffer> {
    const fileName = path.basename(remotePath);
    const activityId = this.activityService.startActivity(
      options?.type || 'download',
      connection.id,
      connection.host.name,
      options?.description || `Download: ${fileName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    try {
      const result = await connection.readFile(remotePath);
      this.activityService.completeActivity(activityId, formatFileSize(result.length));
      return result;
    } catch (error) {
      this.activityService.failActivity(activityId, (error as Error).message);
      throw error;
    }
  }

  /**
   * Write a remote file with activity tracking
   */
  async writeFile(
    connection: SSHConnection,
    remotePath: string,
    content: Buffer | string,
    options?: TrackingOptions
  ): Promise<void> {
    const fileName = path.basename(remotePath);
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
    const activityId = this.activityService.startActivity(
      options?.type || 'upload',
      connection.id,
      connection.host.name,
      options?.description || `Upload: ${fileName}`,
      {
        detail: options?.detail || `${formatFileSize(size)} to ${remotePath}`,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    try {
      const buffer = typeof content === 'string' ? Buffer.from(content) : content;
      await connection.writeFile(remotePath, buffer);
      this.activityService.completeActivity(activityId, formatFileSize(size));
    } catch (error) {
      this.activityService.failActivity(activityId, (error as Error).message);
      throw error;
    }
  }

  /**
   * List directory contents with activity tracking
   */
  async listFiles(
    connection: SSHConnection,
    remotePath: string,
    options?: TrackingOptions
  ): Promise<IRemoteFile[]> {
    const folderName = remotePath === '~' ? 'Home' : path.basename(remotePath) || '/';
    const activityId = this.activityService.startActivity(
      options?.type || 'directory-load',
      connection.id,
      connection.host.name,
      options?.description || `List: ${folderName}`,
      {
        detail: options?.detail || remotePath,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    try {
      const result = await connection.listFiles(remotePath);
      this.activityService.completeActivity(activityId, `${result.length} items`);
      return result;
    } catch (error) {
      this.activityService.failActivity(activityId, (error as Error).message);
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

    try {
      const result = await connection.searchFiles(searchPath, pattern, searchOptions);
      this.activityService.completeActivity(activityId, `${result.length} results`);
      return result;
    } catch (error) {
      this.activityService.failActivity(activityId, (error as Error).message);
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
