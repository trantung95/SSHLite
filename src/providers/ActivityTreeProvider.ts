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
import { ActivityService, Activity, ActivityType, ActivityStatus } from '../services/ActivityService';

/**
 * Grouping mode for activities
 */
export type GroupingMode = 'server' | 'type';

/**
 * Tree item representing a server/connection group
 */
export class ServerGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly serverName: string,
    public readonly activityCount: number,
    public readonly runningCount: number
  ) {
    super(serverName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'serverGroup';
    this.id = `server-${connectionId}`;

    const statusIcon = runningCount > 0 ? '$(sync~spin)' : '$(check)';
    this.description = `${statusIcon} ${activityCount} ${activityCount === 1 ? 'activity' : 'activities'}`;
    this.iconPath = new vscode.ThemeIcon('server');
    this.tooltip = new vscode.MarkdownString(
      `**${serverName}**\n\n` +
      `Running: ${runningCount}\n` +
      `Total: ${activityCount}`
    );
  }
}

/**
 * Tree item representing an activity type group
 */
export class TypeGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly activityType: ActivityType,
    public readonly activityCount: number,
    public readonly runningCount: number
  ) {
    super(getTypeLabel(activityType), vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'typeGroup';
    this.id = `type-${activityType}`;

    const statusIcon = runningCount > 0 ? '$(sync~spin)' : '$(check)';
    this.description = `${statusIcon} ${activityCount}`;
    this.iconPath = new vscode.ThemeIcon(getTypeIcon(activityType));
    this.tooltip = new vscode.MarkdownString(
      `**${getTypeLabel(activityType)}**\n\n` +
      `Running: ${runningCount}\n` +
      `Total: ${activityCount}`
    );
  }
}

/**
 * Tree item representing a single activity
 */
export class ActivityTreeItem extends vscode.TreeItem {
  constructor(public readonly activity: Activity) {
    super(activity.description, vscode.TreeItemCollapsibleState.None);
    this.contextValue = activity.cancellable && activity.status === 'running'
      ? 'cancellableActivity'
      : 'activity';
    this.id = activity.id;

    // Set icon based on status
    this.iconPath = getStatusIcon(activity.status, activity.type);

    // Set description with progress or status
    if (activity.status === 'running') {
      if (activity.progress !== undefined) {
        this.description = `${activity.progress}%`;
      } else {
        this.description = activity.detail || 'Running...';
      }
    } else {
      this.description = activity.detail || getStatusLabel(activity.status);
    }

    // Build tooltip
    const duration = activity.endTime
      ? formatDuration(activity.endTime.getTime() - activity.startTime.getTime())
      : formatDuration(Date.now() - activity.startTime.getTime());

    this.tooltip = new vscode.MarkdownString(
      `**${activity.description}**\n\n` +
      `Type: ${getTypeLabel(activity.type)}\n` +
      `Server: ${activity.serverName}\n` +
      `Status: ${getStatusLabel(activity.status)}\n` +
      `Duration: ${duration}\n` +
      (activity.detail ? `Detail: ${activity.detail}\n` : '') +
      `Started: ${activity.startTime.toLocaleTimeString()}`
    );
  }
}

/**
 * "No activities" placeholder item
 */
export class NoActivitiesTreeItem extends vscode.TreeItem {
  constructor() {
    super('No running activities', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'noActivities';
    this.iconPath = new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));
    this.description = 'All done!';
  }
}

type TreeItem = ServerGroupTreeItem | TypeGroupTreeItem | ActivityTreeItem | NoActivitiesTreeItem;

/**
 * Tree data provider for activities
 */
export class ActivityTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groupingMode: GroupingMode = 'server';
  private activityService: ActivityService;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.activityService = ActivityService.getInstance();

    // Subscribe to activity changes
    this.disposables.push(
      this.activityService.onDidChangeActivities(() => {
        this.refresh();
      })
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  setGroupingMode(mode: GroupingMode): void {
    this.groupingMode = mode;
    this.refresh();
  }

  getGroupingMode(): GroupingMode {
    return this.groupingMode;
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (!element) {
      // Root level
      return Promise.resolve(this.getRootItems());
    }

    if (element instanceof ServerGroupTreeItem) {
      // Return activities for this server
      const activities = this.activityService.getActivitiesForConnection(element.connectionId);
      return Promise.resolve(
        activities
          .sort((a, b) => {
            // Running first, then by start time (newest first)
            if (a.status === 'running' && b.status !== 'running') return -1;
            if (a.status !== 'running' && b.status === 'running') return 1;
            return b.startTime.getTime() - a.startTime.getTime();
          })
          .map(a => new ActivityTreeItem(a))
      );
    }

    if (element instanceof TypeGroupTreeItem) {
      // Return activities of this type
      const byType = this.activityService.getActivitiesByType();
      const activities = byType.get(element.activityType) || [];
      return Promise.resolve(
        activities
          .sort((a, b) => {
            if (a.status === 'running' && b.status !== 'running') return -1;
            if (a.status !== 'running' && b.status === 'running') return 1;
            return b.startTime.getTime() - a.startTime.getTime();
          })
          .map(a => new ActivityTreeItem(a))
      );
    }

    return Promise.resolve([]);
  }

  private getRootItems(): TreeItem[] {
    const allActivities = this.activityService.getAllActivities();

    if (allActivities.length === 0) {
      return [new NoActivitiesTreeItem()];
    }

    if (this.groupingMode === 'server') {
      return this.getServerGroups(allActivities);
    } else {
      return this.getTypeGroups(allActivities);
    }
  }

  private getServerGroups(activities: Activity[]): ServerGroupTreeItem[] {
    // Group activities by connection
    const byServer = new Map<string, { serverName: string; activities: Activity[] }>();

    for (const activity of activities) {
      const key = activity.connectionId || 'global';
      if (!byServer.has(key)) {
        byServer.set(key, {
          serverName: activity.serverName || 'Global',
          activities: [],
        });
      }
      byServer.get(key)!.activities.push(activity);
    }

    // Create tree items sorted by running count (descending)
    return Array.from(byServer.entries())
      .map(([connectionId, data]) => {
        const runningCount = data.activities.filter(a => a.status === 'running').length;
        return new ServerGroupTreeItem(
          connectionId,
          data.serverName,
          data.activities.length,
          runningCount
        );
      })
      .sort((a, b) => b.runningCount - a.runningCount);
  }

  private getTypeGroups(activities: Activity[]): TypeGroupTreeItem[] {
    // Group activities by type
    const byType = new Map<ActivityType, Activity[]>();

    for (const activity of activities) {
      if (!byType.has(activity.type)) {
        byType.set(activity.type, []);
      }
      byType.get(activity.type)!.push(activity);
    }

    // Create tree items sorted by running count (descending)
    return Array.from(byType.entries())
      .map(([type, typeActivities]) => {
        const runningCount = typeActivities.filter(a => a.status === 'running').length;
        return new TypeGroupTreeItem(type, typeActivities.length, runningCount);
      })
      .sort((a, b) => b.runningCount - a.runningCount);
  }

  getParent(element: TreeItem): TreeItem | undefined {
    if (element instanceof ActivityTreeItem) {
      const activity = element.activity;
      if (this.groupingMode === 'server') {
        const byServer = this.activityService.getActivitiesByServer();
        const activities = byServer.get(activity.connectionId || 'global') || [];
        const runningCount = activities.filter(a => a.status === 'running').length;
        return new ServerGroupTreeItem(
          activity.connectionId || 'global',
          activity.serverName || 'Global',
          activities.length,
          runningCount
        );
      } else {
        const byType = this.activityService.getActivitiesByType();
        const activities = byType.get(activity.type) || [];
        const runningCount = activities.filter(a => a.status === 'running').length;
        return new TypeGroupTreeItem(activity.type, activities.length, runningCount);
      }
    }
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

// Helper functions

function getTypeLabel(type: ActivityType): string {
  const labels: Record<ActivityType, string> = {
    search: 'Search',
    download: 'Download',
    upload: 'Upload',
    'directory-load': 'Directory Load',
    'file-refresh': 'File Refresh',
    preload: 'Preload',
    monitor: 'Monitor',
    terminal: 'Terminal',
    connect: 'Connect',
    disconnect: 'Disconnect',
  };
  return labels[type] || type;
}

function getTypeIcon(type: ActivityType): string {
  const icons: Record<ActivityType, string> = {
    search: 'search',
    download: 'cloud-download',
    upload: 'cloud-upload',
    'directory-load': 'folder',
    'file-refresh': 'refresh',
    preload: 'loading',
    monitor: 'pulse',
    terminal: 'terminal',
    connect: 'plug',
    disconnect: 'debug-disconnect',
  };
  return icons[type] || 'circle-outline';
}

function getStatusIcon(status: ActivityStatus, type: ActivityType): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('sync~spin');
    case 'completed':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    default:
      return new vscode.ThemeIcon(getTypeIcon(type));
  }
}

function getStatusLabel(status: ActivityStatus): string {
  const labels: Record<ActivityStatus, string> = {
    running: 'Running',
    completed: 'Completed',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };
  return labels[status] || status;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return '<1s';
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
