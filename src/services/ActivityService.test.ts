import { ActivityService, ActivityType, ActivityStatus } from './ActivityService';

// Reset singleton between tests
function resetActivityService(): ActivityService {
  const instance = ActivityService.getInstance();
  instance.dispose();
  return ActivityService.getInstance();
}

describe('ActivityService', () => {
  let service: ActivityService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = resetActivityService();
  });

  afterEach(() => {
    jest.useRealTimers();
    service.dispose();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ActivityService.getInstance();
      const instance2 = ActivityService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('startActivity', () => {
    it('should create a running activity with unique ID', () => {
      const id = service.startActivity('search', 'conn1', 'Server1', 'Searching files');
      expect(id).toMatch(/^activity-\d+-\d+$/);

      const activities = service.getAllActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        id,
        type: 'search',
        connectionId: 'conn1',
        serverName: 'Server1',
        description: 'Searching files',
        status: 'running',
        cancellable: false,
      });
      expect(activities[0].startTime).toBeInstanceOf(Date);
    });

    it('should support optional detail and cancellable options', () => {
      const onCancel = jest.fn();
      const id = service.startActivity('download', 'conn1', 'Server1', 'Downloading', {
        detail: '/path/to/file',
        cancellable: true,
        onCancel,
      });

      const activities = service.getAllActivities();
      expect(activities[0]).toMatchObject({
        detail: '/path/to/file',
        cancellable: true,
      });
      expect(activities[0].onCancel).toBe(onCancel);
    });

    it('should generate unique IDs for multiple activities', () => {
      const id1 = service.startActivity('search', 'conn1', 'S1', 'Search 1');
      const id2 = service.startActivity('download', 'conn1', 'S1', 'Download 1');
      expect(id1).not.toBe(id2);
      expect(service.getAllActivities()).toHaveLength(2);
    });
  });

  describe('completeActivity', () => {
    it('should set status to completed with endTime and progress 100', () => {
      const id = service.startActivity('upload', 'conn1', 'S1', 'Uploading');
      service.completeActivity(id, '1.5 KB');

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.status).toBe('completed');
      expect(activity.endTime).toBeInstanceOf(Date);
      expect(activity.progress).toBe(100);
      expect(activity.detail).toBe('1.5 KB');
    });

    it('should auto-remove after 3 seconds', () => {
      const id = service.startActivity('upload', 'conn1', 'S1', 'Uploading');
      service.completeActivity(id);

      expect(service.getAllActivities()).toHaveLength(1);
      jest.advanceTimersByTime(3000);
      expect(service.getAllActivities()).toHaveLength(0);
    });

    it('should do nothing for non-existent activity', () => {
      service.completeActivity('non-existent');
      expect(service.getAllActivities()).toHaveLength(0);
    });
  });

  describe('failActivity', () => {
    it('should set status to failed with error detail', () => {
      const id = service.startActivity('download', 'conn1', 'S1', 'Downloading');
      service.failActivity(id, 'Connection refused');

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.status).toBe('failed');
      expect(activity.detail).toBe('Connection refused');
      expect(activity.endTime).toBeInstanceOf(Date);
    });

    it('should auto-remove after 5 seconds', () => {
      const id = service.startActivity('download', 'conn1', 'S1', 'Downloading');
      service.failActivity(id);

      expect(service.getAllActivities()).toHaveLength(1);
      jest.advanceTimersByTime(5000);
      expect(service.getAllActivities()).toHaveLength(0);
    });
  });

  describe('cancelActivity', () => {
    it('should call onCancel callback and set cancelled status', () => {
      const onCancel = jest.fn();
      const id = service.startActivity('search', 'conn1', 'S1', 'Searching', {
        cancellable: true,
        onCancel,
      });

      service.cancelActivity(id);

      expect(onCancel).toHaveBeenCalledTimes(1);
      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.status).toBe('cancelled');
      expect(activity.detail).toBe('Cancelled');
      expect(activity.endTime).toBeInstanceOf(Date);
    });

    it('should not cancel non-running activity', () => {
      const id = service.startActivity('search', 'conn1', 'S1', 'Searching');
      service.completeActivity(id);
      service.cancelActivity(id); // Already completed

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.status).toBe('completed'); // Status unchanged
    });

    it('should auto-remove after 3 seconds', () => {
      const id = service.startActivity('search', 'conn1', 'S1', 'Searching');
      service.cancelActivity(id);

      expect(service.getAllActivities()).toHaveLength(1);
      jest.advanceTimersByTime(3000);
      expect(service.getAllActivities()).toHaveLength(0);
    });
  });

  describe('updateProgress', () => {
    it('should update progress and detail', () => {
      const id = service.startActivity('download', 'conn1', 'S1', 'Downloading');
      service.updateProgress(id, 50, '50% done');

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.progress).toBe(50);
      expect(activity.detail).toBe('50% done');
    });

    it('should clamp progress to 0-100', () => {
      const id = service.startActivity('download', 'conn1', 'S1', 'Downloading');

      service.updateProgress(id, -10);
      expect(service.getAllActivities().find(a => a.id === id)!.progress).toBe(0);

      service.updateProgress(id, 150);
      expect(service.getAllActivities().find(a => a.id === id)!.progress).toBe(100);
    });

    it('should not update non-running activity', () => {
      const id = service.startActivity('download', 'conn1', 'S1', 'Downloading');
      service.completeActivity(id);
      service.updateProgress(id, 50, 'Should not update');

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.progress).toBe(100); // Still 100 from completion
    });
  });

  describe('updateDetail', () => {
    it('should update detail on running activity', () => {
      const id = service.startActivity('monitor', 'conn1', 'S1', 'Watching');
      service.updateDetail(id, 'New detail');

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.detail).toBe('New detail');
    });

    it('should not update detail on completed activity', () => {
      const id = service.startActivity('monitor', 'conn1', 'S1', 'Watching', {
        detail: 'Original',
      });
      service.completeActivity(id, 'Done');
      service.updateDetail(id, 'Should not change');

      const activity = service.getAllActivities().find(a => a.id === id)!;
      expect(activity.detail).toBe('Done');
    });
  });

  describe('getRunningActivities', () => {
    it('should only return running activities', () => {
      const id1 = service.startActivity('search', 'conn1', 'S1', 'Search 1');
      const id2 = service.startActivity('download', 'conn1', 'S1', 'Download 1');
      service.completeActivity(id1);

      const running = service.getRunningActivities();
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(id2);
    });
  });

  describe('getActivitiesByServer', () => {
    it('should group activities by connectionId', () => {
      service.startActivity('search', 'conn1', 'Server1', 'Search 1');
      service.startActivity('search', 'conn2', 'Server2', 'Search 2');
      service.startActivity('download', 'conn1', 'Server1', 'Download 1');

      const grouped = service.getActivitiesByServer();
      expect(grouped.get('conn1')).toHaveLength(2);
      expect(grouped.get('conn2')).toHaveLength(1);
    });
  });

  describe('getActivitiesByType', () => {
    it('should group activities by type', () => {
      service.startActivity('search', 'conn1', 'S1', 'Search');
      service.startActivity('search', 'conn2', 'S2', 'Search 2');
      service.startActivity('download', 'conn1', 'S1', 'Download');

      const grouped = service.getActivitiesByType();
      expect(grouped.get('search')).toHaveLength(2);
      expect(grouped.get('download')).toHaveLength(1);
    });
  });

  describe('getActivitiesForConnection', () => {
    it('should return all activities for a specific connection', () => {
      service.startActivity('search', 'conn1', 'S1', 'Search');
      service.startActivity('download', 'conn1', 'S1', 'Download');
      service.startActivity('search', 'conn2', 'S2', 'Other search');

      const conn1Activities = service.getActivitiesForConnection('conn1');
      expect(conn1Activities).toHaveLength(2);
    });
  });

  describe('hasRunningActivities', () => {
    it('should return false when no activities', () => {
      expect(service.hasRunningActivities()).toBe(false);
    });

    it('should return true when activities are running', () => {
      service.startActivity('search', 'conn1', 'S1', 'Searching');
      expect(service.hasRunningActivities()).toBe(true);
    });

    it('should return false when all activities completed', () => {
      const id = service.startActivity('search', 'conn1', 'S1', 'Searching');
      service.completeActivity(id);
      expect(service.hasRunningActivities()).toBe(false);
    });
  });

  describe('cancelAllForConnection', () => {
    it('should cancel all running activities for a connection', () => {
      const onCancel1 = jest.fn();
      const onCancel2 = jest.fn();
      service.startActivity('search', 'conn1', 'S1', 'Search 1', { onCancel: onCancel1 });
      service.startActivity('download', 'conn1', 'S1', 'Download 1', { onCancel: onCancel2 });
      service.startActivity('search', 'conn2', 'S2', 'Search 2');

      service.cancelAllForConnection('conn1');

      expect(onCancel1).toHaveBeenCalledTimes(1);
      expect(onCancel2).toHaveBeenCalledTimes(1);

      const conn1Activities = service.getActivitiesForConnection('conn1');
      expect(conn1Activities.every(a => a.status === 'cancelled')).toBe(true);

      // conn2 should be unaffected
      const conn2Activities = service.getActivitiesForConnection('conn2');
      expect(conn2Activities[0].status).toBe('running');
    });
  });

  describe('cancelAll', () => {
    it('should cancel all running activities', () => {
      service.startActivity('search', 'conn1', 'S1', 'Search');
      service.startActivity('download', 'conn2', 'S2', 'Download');

      service.cancelAll();

      const activities = service.getAllActivities();
      expect(activities.every(a => a.status === 'cancelled')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should remove all activities', () => {
      service.startActivity('search', 'conn1', 'S1', 'Search');
      service.startActivity('download', 'conn1', 'S1', 'Download');

      service.clearAll();
      expect(service.getAllActivities()).toHaveLength(0);
    });
  });

  describe('removeActivity', () => {
    it('should remove a specific activity', () => {
      const id = service.startActivity('search', 'conn1', 'S1', 'Search');
      service.startActivity('download', 'conn1', 'S1', 'Download');

      service.removeActivity(id);
      expect(service.getAllActivities()).toHaveLength(1);
    });

    it('should do nothing for non-existent activity', () => {
      service.startActivity('search', 'conn1', 'S1', 'Search');
      service.removeActivity('non-existent');
      expect(service.getAllActivities()).toHaveLength(1);
    });
  });
});
