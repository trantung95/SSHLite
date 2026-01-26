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

import * as vscode from 'vscode';

/**
 * Types of activities that can be tracked
 */
export type ActivityType =
  | 'search'
  | 'download'
  | 'upload'
  | 'directory-load'
  | 'file-refresh'
  | 'preload'
  | 'monitor'
  | 'terminal'
  | 'connect'
  | 'disconnect';

/**
 * Status of an activity
 */
export type ActivityStatus = 'running' | 'completed' | 'cancelled' | 'failed';

/**
 * Represents a single tracked activity
 */
export interface Activity {
  id: string;
  type: ActivityType;
  connectionId: string;
  serverName: string;
  description: string;
  detail?: string;
  status: ActivityStatus;
  startTime: Date;
  endTime?: Date;
  progress?: number; // 0-100
  cancellable: boolean;
  onCancel?: () => void;
}

/**
 * Service for tracking all running operations in the extension
 */
export class ActivityService {
  private static _instance: ActivityService;
  private activities: Map<string, Activity> = new Map();
  private activityCounter = 0;

  private readonly _onDidChangeActivities = new vscode.EventEmitter<void>();
  public readonly onDidChangeActivities = this._onDidChangeActivities.event;

  private constructor() {}

  static getInstance(): ActivityService {
    if (!ActivityService._instance) {
      ActivityService._instance = new ActivityService();
    }
    return ActivityService._instance;
  }

  /**
   * Start tracking a new activity
   */
  startActivity(
    type: ActivityType,
    connectionId: string,
    serverName: string,
    description: string,
    options: {
      detail?: string;
      cancellable?: boolean;
      onCancel?: () => void;
    } = {}
  ): string {
    const id = `activity-${++this.activityCounter}-${Date.now()}`;
    const activity: Activity = {
      id,
      type,
      connectionId,
      serverName,
      description,
      detail: options.detail,
      status: 'running',
      startTime: new Date(),
      cancellable: options.cancellable ?? false,
      onCancel: options.onCancel,
    };

    this.activities.set(id, activity);
    this._onDidChangeActivities.fire();
    return id;
  }

  /**
   * Update an activity's progress
   */
  updateProgress(id: string, progress: number, detail?: string): void {
    const activity = this.activities.get(id);
    if (activity && activity.status === 'running') {
      activity.progress = Math.min(100, Math.max(0, progress));
      if (detail !== undefined) {
        activity.detail = detail;
      }
      this._onDidChangeActivities.fire();
    }
  }

  /**
   * Update an activity's detail text
   */
  updateDetail(id: string, detail: string): void {
    const activity = this.activities.get(id);
    if (activity && activity.status === 'running') {
      activity.detail = detail;
      this._onDidChangeActivities.fire();
    }
  }

  /**
   * Complete an activity successfully
   */
  completeActivity(id: string, detail?: string): void {
    const activity = this.activities.get(id);
    if (activity) {
      activity.status = 'completed';
      activity.endTime = new Date();
      activity.progress = 100;
      if (detail !== undefined) {
        activity.detail = detail;
      }
      this._onDidChangeActivities.fire();

      // Remove completed activities after 3 seconds
      setTimeout(() => {
        this.removeActivity(id);
      }, 3000);
    }
  }

  /**
   * Mark an activity as failed
   */
  failActivity(id: string, error?: string): void {
    const activity = this.activities.get(id);
    if (activity) {
      activity.status = 'failed';
      activity.endTime = new Date();
      if (error) {
        activity.detail = error;
      }
      this._onDidChangeActivities.fire();

      // Remove failed activities after 5 seconds
      setTimeout(() => {
        this.removeActivity(id);
      }, 5000);
    }
  }

  /**
   * Cancel an activity
   */
  cancelActivity(id: string): void {
    const activity = this.activities.get(id);
    if (activity && activity.status === 'running') {
      if (activity.onCancel) {
        activity.onCancel();
      }
      activity.status = 'cancelled';
      activity.endTime = new Date();
      activity.detail = 'Cancelled';
      this._onDidChangeActivities.fire();

      // Remove cancelled activities after 3 seconds
      setTimeout(() => {
        this.removeActivity(id);
      }, 3000);
    }
  }

  /**
   * Remove an activity from tracking
   */
  removeActivity(id: string): void {
    if (this.activities.delete(id)) {
      this._onDidChangeActivities.fire();
    }
  }

  /**
   * Get all activities
   */
  getAllActivities(): Activity[] {
    return Array.from(this.activities.values());
  }

  /**
   * Get running activities
   */
  getRunningActivities(): Activity[] {
    return Array.from(this.activities.values()).filter(a => a.status === 'running');
  }

  /**
   * Get activities grouped by server
   */
  getActivitiesByServer(): Map<string, Activity[]> {
    const grouped = new Map<string, Activity[]>();
    for (const activity of this.activities.values()) {
      const key = activity.connectionId || 'global';
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(activity);
    }
    return grouped;
  }

  /**
   * Get activities grouped by type
   */
  getActivitiesByType(): Map<ActivityType, Activity[]> {
    const grouped = new Map<ActivityType, Activity[]>();
    for (const activity of this.activities.values()) {
      if (!grouped.has(activity.type)) {
        grouped.set(activity.type, []);
      }
      grouped.get(activity.type)!.push(activity);
    }
    return grouped;
  }

  /**
   * Get all activities for a specific connection
   */
  getActivitiesForConnection(connectionId: string): Activity[] {
    return Array.from(this.activities.values()).filter(
      a => a.connectionId === connectionId
    );
  }

  /**
   * Check if there are any running activities
   */
  hasRunningActivities(): boolean {
    return Array.from(this.activities.values()).some(a => a.status === 'running');
  }

  /**
   * Check if there are any activities for a connection
   */
  hasActivitiesForConnection(connectionId: string): boolean {
    return Array.from(this.activities.values()).some(
      a => a.connectionId === connectionId && a.status === 'running'
    );
  }

  /**
   * Cancel all running activities for a connection
   */
  cancelAllForConnection(connectionId: string): void {
    for (const activity of this.activities.values()) {
      if (activity.connectionId === connectionId && activity.status === 'running') {
        this.cancelActivity(activity.id);
      }
    }
  }

  /**
   * Cancel all running activities
   */
  cancelAll(): void {
    for (const activity of this.activities.values()) {
      if (activity.status === 'running') {
        this.cancelActivity(activity.id);
      }
    }
  }

  /**
   * Clear all activities (including completed)
   */
  clearAll(): void {
    this.activities.clear();
    this._onDidChangeActivities.fire();
  }

  /**
   * Dispose of the service
   */
  dispose(): void {
    this.activities.clear();
    this._onDidChangeActivities.dispose();
    ActivityService._instance = undefined as unknown as ActivityService;
  }
}
