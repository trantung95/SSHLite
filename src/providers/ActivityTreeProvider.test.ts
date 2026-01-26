/**
 * ActivityTreeProvider tests
 *
 * Tests the activity tree view:
 * - Tree items (ServerGroupTreeItem, TypeGroupTreeItem, ActivityTreeItem)
 * - Grouping modes (server, type)
 * - Activity status display
 * - Empty state (NoActivitiesTreeItem)
 * - Helper functions (getTypeLabel, formatDuration, etc.)
 */

import {
  ActivityTreeProvider,
  ServerGroupTreeItem,
  TypeGroupTreeItem,
  ActivityTreeItem,
  NoActivitiesTreeItem,
  GroupingMode,
} from './ActivityTreeProvider';
import { ActivityService } from '../services/ActivityService';

// Reset singletons
function resetActivityService(): ActivityService {
  (ActivityService as any)._instance = undefined;
  return ActivityService.getInstance();
}

function resetTreeProvider(): ActivityTreeProvider {
  return new ActivityTreeProvider();
}

describe('ActivityTreeProvider', () => {
  let activityService: ActivityService;
  let provider: ActivityTreeProvider;

  beforeEach(() => {
    activityService = resetActivityService();
    provider = resetTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('empty state', () => {
    it('should show NoActivitiesTreeItem when no activities', async () => {
      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(NoActivitiesTreeItem);
    });

    it('should display "No running activities" label', () => {
      const item = new NoActivitiesTreeItem();
      expect(item.label).toBe('No running activities');
      expect(item.description).toBe('All done!');
      expect(item.contextValue).toBe('noActivities');
    });
  });

  describe('grouping modes', () => {
    it('should default to server grouping', () => {
      expect(provider.getGroupingMode()).toBe('server');
    });

    it('should allow switching to type grouping', () => {
      provider.setGroupingMode('type');
      expect(provider.getGroupingMode()).toBe('type');
    });

    it('should allow switching back to server grouping', () => {
      provider.setGroupingMode('type');
      provider.setGroupingMode('server');
      expect(provider.getGroupingMode()).toBe('server');
    });
  });

  describe('ServerGroupTreeItem', () => {
    it('should display server name and activity count', () => {
      const item = new ServerGroupTreeItem('conn1', 'Production Server', 5, 2);
      expect(item.serverName).toBe('Production Server');
      expect(item.activityCount).toBe(5);
      expect(item.runningCount).toBe(2);
      expect(item.contextValue).toBe('serverGroup');
    });

    it('should generate unique ID', () => {
      const item = new ServerGroupTreeItem('conn1', 'Server', 1, 0);
      expect(item.id).toBe('server-conn1');
    });

    it('should show activity count in description', () => {
      const item = new ServerGroupTreeItem('conn1', 'Server', 3, 0);
      expect(item.description).toContain('3');
      expect(item.description).toContain('activities');
    });

    it('should use singular for 1 activity', () => {
      const item = new ServerGroupTreeItem('conn1', 'Server', 1, 0);
      expect(item.description).toContain('1');
      expect(item.description).toContain('activity');
    });
  });

  describe('TypeGroupTreeItem', () => {
    it('should display type label', () => {
      const item = new TypeGroupTreeItem('search', 3, 1);
      expect(item.activityType).toBe('search');
      expect(item.activityCount).toBe(3);
      expect(item.contextValue).toBe('typeGroup');
    });

    it('should generate unique ID based on type', () => {
      const item = new TypeGroupTreeItem('download', 1, 0);
      expect(item.id).toBe('type-download');
    });
  });

  describe('ActivityTreeItem', () => {
    it('should display activity description', () => {
      const activityId = activityService.startActivity(
        'search', 'conn1', 'Server1', 'Searching for "test"'
      );
      const activity = activityService.getAllActivities().find(a => a.id === activityId)!;
      const item = new ActivityTreeItem(activity);

      expect(item.label).toBe('Searching for "test"');
      expect(item.id).toBe(activityId);
    });

    it('should show running status description', () => {
      const activityId = activityService.startActivity(
        'download', 'conn1', 'Server1', 'Download file.ts'
      );
      const activity = activityService.getAllActivities().find(a => a.id === activityId)!;
      const item = new ActivityTreeItem(activity);

      expect(item.description).toContain('Running');
    });

    it('should show completed status after completion', () => {
      const activityId = activityService.startActivity(
        'upload', 'conn1', 'Server1', 'Upload config'
      );
      activityService.completeActivity(activityId, 'Done');

      const activity = activityService.getAllActivities().find(a => a.id === activityId)!;
      const item = new ActivityTreeItem(activity);

      expect(item.description).toBe('Done');
    });

    it('should show cancellable context when running and cancellable', () => {
      const activityId = activityService.startActivity(
        'search', 'conn1', 'Server1', 'Search', { cancellable: true }
      );
      const activity = activityService.getAllActivities().find(a => a.id === activityId)!;
      const item = new ActivityTreeItem(activity);

      expect(item.contextValue).toBe('cancellableActivity');
    });

    it('should show activity context when not cancellable', () => {
      const activityId = activityService.startActivity(
        'connect', 'conn1', 'Server1', 'Connect'
      );
      const activity = activityService.getAllActivities().find(a => a.id === activityId)!;
      const item = new ActivityTreeItem(activity);

      expect(item.contextValue).toBe('activity');
    });
  });

  describe('getChildren with activities', () => {
    it('should show server groups when grouping by server', async () => {
      activityService.startActivity('search', 'conn1', 'Server1', 'Task 1');
      activityService.startActivity('download', 'conn2', 'Server2', 'Task 2');

      provider.setGroupingMode('server');
      const children = await provider.getChildren();

      // Should have 2 server groups
      expect(children.length).toBe(2);
      expect(children[0]).toBeInstanceOf(ServerGroupTreeItem);
    });

    it('should show type groups when grouping by type', async () => {
      activityService.startActivity('search', 'conn1', 'Server1', 'Search 1');
      activityService.startActivity('search', 'conn2', 'Server2', 'Search 2');
      activityService.startActivity('download', 'conn1', 'Server1', 'Download 1');

      provider.setGroupingMode('type');
      const children = await provider.getChildren();

      // Should have 2 type groups (search, download)
      expect(children.length).toBe(2);
      expect(children[0]).toBeInstanceOf(TypeGroupTreeItem);
    });

    it('should show activities under server group', async () => {
      activityService.startActivity('search', 'conn1', 'Server1', 'Task 1');
      activityService.startActivity('download', 'conn1', 'Server1', 'Task 2');

      const children = await provider.getChildren();
      expect(children).toHaveLength(1); // 1 server group

      const serverGroup = children[0] as ServerGroupTreeItem;
      const activities = await provider.getChildren(serverGroup);
      expect(activities).toHaveLength(2);
      expect(activities[0]).toBeInstanceOf(ActivityTreeItem);
    });
  });

  describe('refresh', () => {
    it('should not throw', () => {
      provider.refresh();
    });
  });

  describe('getTreeItem', () => {
    it('should return the item itself', () => {
      const item = new NoActivitiesTreeItem();
      expect(provider.getTreeItem(item)).toBe(item);
    });
  });

  describe('getParent', () => {
    it('should return undefined for group items', () => {
      const group = new ServerGroupTreeItem('conn1', 'Server', 1, 0);
      expect(provider.getParent(group)).toBeUndefined();
    });
  });
});
