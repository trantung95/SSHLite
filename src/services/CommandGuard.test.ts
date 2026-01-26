import { CommandGuard } from './CommandGuard';
import { ActivityService } from './ActivityService';

// Mock SSHConnection
function createMockConnection(overrides: Partial<{
  id: string;
  host: { name: string; host: string; port: number; username: string };
  exec: jest.Mock;
  readFile: jest.Mock;
  writeFile: jest.Mock;
  listFiles: jest.Mock;
  searchFiles: jest.Mock;
}> = {}) {
  return {
    id: overrides.id || 'test:22:user',
    host: overrides.host || { name: 'TestServer', host: 'test', port: 22, username: 'user' },
    exec: overrides.exec || jest.fn().mockResolvedValue('output'),
    readFile: overrides.readFile || jest.fn().mockResolvedValue(Buffer.from('file content')),
    writeFile: overrides.writeFile || jest.fn().mockResolvedValue(undefined),
    listFiles: overrides.listFiles || jest.fn().mockResolvedValue([]),
    searchFiles: overrides.searchFiles || jest.fn().mockResolvedValue([]),
  } as unknown as Parameters<typeof CommandGuard.prototype.exec>[0];
}

// Reset singletons
function resetServices() {
  const activityService = ActivityService.getInstance();
  activityService.dispose();
  // Reset CommandGuard singleton
  (CommandGuard as unknown as { _instance: CommandGuard | undefined })._instance = undefined;
}

describe('CommandGuard', () => {
  let guard: CommandGuard;
  let activityService: ActivityService;

  beforeEach(() => {
    jest.useFakeTimers();
    resetServices();
    guard = CommandGuard.getInstance();
    activityService = ActivityService.getInstance();
  });

  afterEach(() => {
    jest.useRealTimers();
    activityService.dispose();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = CommandGuard.getInstance();
      const instance2 = CommandGuard.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('exec', () => {
    it('should execute command and track activity', async () => {
      const conn = createMockConnection({
        exec: jest.fn().mockResolvedValue('hello world'),
      });

      const result = await guard.exec(conn, 'echo hello');

      expect(result).toBe('hello world');
      expect(conn.exec).toHaveBeenCalledWith('echo hello');

      // Activity should be completed
      const activities = activityService.getAllActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0].status).toBe('completed');
    });

    it('should track activity as failed on error', async () => {
      const conn = createMockConnection({
        exec: jest.fn().mockRejectedValue(new Error('Connection lost')),
      });

      await expect(guard.exec(conn, 'echo hello')).rejects.toThrow('Connection lost');

      const activities = activityService.getAllActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0].status).toBe('failed');
      expect(activities[0].detail).toBe('Connection lost');
    });

    it('should use custom description from options', async () => {
      const conn = createMockConnection();
      await guard.exec(conn, 'grep -r "test"', { description: 'Custom search' });

      const activities = activityService.getAllActivities();
      expect(activities[0].description).toBe('Custom search');
    });

    it('should extract command description for grep', async () => {
      const conn = createMockConnection();
      await guard.exec(conn, 'grep -r "test" /path');

      const activities = activityService.getAllActivities();
      expect(activities[0].description).toBe('Search content');
    });

    it('should extract command description for find', async () => {
      const conn = createMockConnection();
      await guard.exec(conn, 'find /path -name "*.ts"');

      const activities = activityService.getAllActivities();
      expect(activities[0].description).toBe('Find files');
    });

    it('should truncate long command descriptions', async () => {
      const conn = createMockConnection();
      const longCommand = 'somecommand ' + 'a'.repeat(100);
      await guard.exec(conn, longCommand);

      const activities = activityService.getAllActivities();
      expect(activities[0].description.length).toBeLessThanOrEqual(53); // 50 + "..."
      expect(activities[0].description).toContain('...');
    });
  });

  describe('readFile', () => {
    it('should read file and track download activity', async () => {
      const fileContent = Buffer.from('test content');
      const conn = createMockConnection({
        readFile: jest.fn().mockResolvedValue(fileContent),
      });

      const result = await guard.readFile(conn, '/home/user/test.txt');

      expect(result).toBe(fileContent);
      expect(conn.readFile).toHaveBeenCalledWith('/home/user/test.txt');

      const activities = activityService.getAllActivities();
      expect(activities[0].type).toBe('download');
      expect(activities[0].status).toBe('completed');
      expect(activities[0].description).toBe('Download: test.txt');
    });

    it('should track as failed on read error', async () => {
      const conn = createMockConnection({
        readFile: jest.fn().mockRejectedValue(new Error('Permission denied')),
      });

      await expect(guard.readFile(conn, '/etc/shadow')).rejects.toThrow('Permission denied');

      const activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('failed');
      expect(activities[0].detail).toBe('Permission denied');
    });
  });

  describe('writeFile', () => {
    it('should write file and track upload activity', async () => {
      const conn = createMockConnection();
      const content = Buffer.from('new content');

      await guard.writeFile(conn, '/home/user/test.txt', content);

      expect(conn.writeFile).toHaveBeenCalledWith('/home/user/test.txt', content);

      const activities = activityService.getAllActivities();
      expect(activities[0].type).toBe('upload');
      expect(activities[0].status).toBe('completed');
      expect(activities[0].description).toBe('Upload: test.txt');
    });

    it('should convert string content to buffer', async () => {
      const conn = createMockConnection();
      await guard.writeFile(conn, '/home/user/test.txt', 'string content');

      expect(conn.writeFile).toHaveBeenCalledWith(
        '/home/user/test.txt',
        Buffer.from('string content')
      );
    });

    it('should track as failed on write error', async () => {
      const conn = createMockConnection({
        writeFile: jest.fn().mockRejectedValue(new Error('Disk full')),
      });

      await expect(
        guard.writeFile(conn, '/home/user/test.txt', Buffer.from('data'))
      ).rejects.toThrow('Disk full');

      const activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('failed');
    });
  });

  describe('listFiles', () => {
    it('should list files and track directory-load activity', async () => {
      const files = [{ name: 'test.ts', path: '/test.ts', isDirectory: false }];
      const conn = createMockConnection({
        listFiles: jest.fn().mockResolvedValue(files),
      });

      const result = await guard.listFiles(conn, '/home/user');

      expect(result).toBe(files);
      const activities = activityService.getAllActivities();
      expect(activities[0].type).toBe('directory-load');
      expect(activities[0].status).toBe('completed');
      expect(activities[0].detail).toBe('1 items');
    });

    it('should use "Home" for home directory', async () => {
      const conn = createMockConnection({
        listFiles: jest.fn().mockResolvedValue([]),
      });

      await guard.listFiles(conn, '~');

      const activities = activityService.getAllActivities();
      expect(activities[0].description).toBe('List: Home');
    });
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('should start and stop monitoring activity', () => {
      const conn = createMockConnection();
      const onCancel = jest.fn();

      const activityId = guard.startMonitoring(conn, '/home/user/test.txt', { onCancel });

      let activities = activityService.getAllActivities();
      expect(activities[0].type).toBe('monitor');
      expect(activities[0].status).toBe('running');
      expect(activities[0].description).toBe('Watch: test.txt');

      guard.stopMonitoring(activityId, 'File closed');

      activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('completed');
    });

    it('should cancel monitoring when reason is "cancelled"', () => {
      const conn = createMockConnection();
      const activityId = guard.startMonitoring(conn, '/test.txt');

      guard.stopMonitoring(activityId, 'cancelled');

      const activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('cancelled');
    });
  });

  describe('startConnect / completeConnect / failConnect', () => {
    it('should track successful connection', () => {
      const activityId = guard.startConnect('Server1', 'conn1');

      let activities = activityService.getAllActivities();
      expect(activities[0].type).toBe('connect');
      expect(activities[0].description).toBe('Connecting to Server1');

      guard.completeConnect(activityId);

      activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('completed');
      expect(activities[0].detail).toBe('Connected');
    });

    it('should track failed connection', () => {
      const activityId = guard.startConnect('Server1', 'conn1');
      guard.failConnect(activityId, 'Auth failed');

      const activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('failed');
      expect(activities[0].detail).toBe('Auth failed');
    });
  });

  describe('trackDisconnect', () => {
    it('should create and immediately complete disconnect activity', () => {
      const conn = createMockConnection();
      guard.trackDisconnect(conn);

      const activities = activityService.getAllActivities();
      expect(activities[0].type).toBe('disconnect');
      expect(activities[0].status).toBe('completed');
      expect(activities[0].detail).toBe('Disconnected');
    });
  });
});
