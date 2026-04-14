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
  sudoMode: boolean;
  sudoPassword: string | null;
  sudoExec: jest.Mock;
  sudoReadFile: jest.Mock;
  sudoWriteFile: jest.Mock;
  sudoListFiles: jest.Mock;
  sudoDeleteFile: jest.Mock;
  sudoMkdir: jest.Mock;
  sudoRename: jest.Mock;
}> = {}) {
  return {
    id: overrides.id || 'test:22:user',
    host: overrides.host || { name: 'TestServer', host: 'test', port: 22, username: 'user' },
    exec: overrides.exec || jest.fn().mockResolvedValue('output'),
    readFile: overrides.readFile || jest.fn().mockResolvedValue(Buffer.from('file content')),
    writeFile: overrides.writeFile || jest.fn().mockResolvedValue(undefined),
    listFiles: overrides.listFiles || jest.fn().mockResolvedValue([]),
    searchFiles: overrides.searchFiles || jest.fn().mockResolvedValue([]),
    sudoMode: overrides.sudoMode ?? false,
    sudoPassword: overrides.sudoPassword ?? null,
    sudoExec: overrides.sudoExec || jest.fn().mockResolvedValue('sudo output'),
    sudoReadFile: overrides.sudoReadFile || jest.fn().mockResolvedValue(Buffer.from('sudo content')),
    sudoWriteFile: overrides.sudoWriteFile || jest.fn().mockResolvedValue(undefined),
    sudoListFiles: overrides.sudoListFiles || jest.fn().mockResolvedValue([]),
    sudoDeleteFile: overrides.sudoDeleteFile || jest.fn().mockResolvedValue(undefined),
    sudoMkdir: overrides.sudoMkdir || jest.fn().mockResolvedValue(undefined),
    sudoRename: overrides.sudoRename || jest.fn().mockResolvedValue(undefined),
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

  // Note: "exec" below refers to SSHConnection.exec (remote SSH command),
  // not child_process.exec (local). No local shell injection risk.
  describe('Sudo mode auto-routing', () => {
    it('should route through sudoExec when sudo mode is active', async () => {
      const conn = createMockConnection({ sudoMode: true, sudoPassword: 'pass' });
      await guard.exec(conn, 'ls /root');
      expect((conn as any).sudoExec).toHaveBeenCalledWith('ls /root', 'pass');
      expect((conn as any).exec).not.toHaveBeenCalled();
    });

    it('should use normal path when sudo mode is inactive', async () => {
      const conn = createMockConnection({ sudoMode: false });
      await guard.exec(conn, 'ls /home');
      expect((conn as any).exec).toHaveBeenCalledWith('ls /home');
      expect((conn as any).sudoExec).not.toHaveBeenCalled();
    });

    it('should route readFile through sudoReadFile when sudo mode is active', async () => {
      const conn = createMockConnection({ sudoMode: true, sudoPassword: 'pass' });
      await guard.readFile(conn, '/etc/shadow');
      expect((conn as any).sudoReadFile).toHaveBeenCalledWith('/etc/shadow', 'pass');
      expect((conn as any).readFile).not.toHaveBeenCalled();
    });

    it('should route writeFile through sudoWriteFile when sudo mode is active', async () => {
      const conn = createMockConnection({ sudoMode: true, sudoPassword: 'pass' });
      await guard.writeFile(conn, '/etc/hosts', Buffer.from('data'));
      expect((conn as any).sudoWriteFile).toHaveBeenCalledWith('/etc/hosts', Buffer.from('data'), 'pass');
      expect((conn as any).writeFile).not.toHaveBeenCalled();
    });

    it('should route listFiles through sudoListFiles when sudo mode is active', async () => {
      const conn = createMockConnection({ sudoMode: true, sudoPassword: 'pass' });
      await guard.listFiles(conn, '/root');
      expect((conn as any).sudoListFiles).toHaveBeenCalledWith('/root', 'pass');
      expect((conn as any).listFiles).not.toHaveBeenCalled();
    });

    it('should prefix activity description with "Sudo" when sudo mode is active', async () => {
      const conn = createMockConnection({ sudoMode: true, sudoPassword: 'pass' });
      await guard.readFile(conn, '/etc/shadow');

      const activities = activityService.getAllActivities();
      expect(activities[0].description).toContain('Sudo');
    });

    it('should not prefix activity description when sudo mode is inactive', async () => {
      const conn = createMockConnection({ sudoMode: false });
      await guard.readFile(conn, '/home/user/file.txt');

      const activities = activityService.getAllActivities();
      expect(activities[0].description).not.toContain('Sudo');
    });
  });

  describe('Explicit sudo wrappers (one-off)', () => {
    it('sudoWriteFile should call connection.sudoWriteFile with password', async () => {
      const conn = createMockConnection();
      await guard.sudoWriteFile(conn, '/etc/config', Buffer.from('data'), 'mypass');
      expect((conn as any).sudoWriteFile).toHaveBeenCalledWith('/etc/config', Buffer.from('data'), 'mypass');
    });

    it('sudoWriteFile should track activity with Sudo prefix', async () => {
      const conn = createMockConnection();
      await guard.sudoWriteFile(conn, '/etc/config.yml', Buffer.from('data'), 'pass');
      const activities = activityService.getAllActivities();
      expect(activities[0].description).toContain('Sudo Save');
      expect(activities[0].description).toContain('config.yml');
    });

    it('sudoReadFile should call connection.sudoReadFile and return buffer', async () => {
      const conn = createMockConnection({
        sudoReadFile: jest.fn().mockResolvedValue(Buffer.from('secret data')),
      });
      const result = await guard.sudoReadFile(conn, '/etc/shadow', 'pass');
      expect(result.toString()).toBe('secret data');
    });

    it('sudoDeleteFile should call connection.sudoDeleteFile', async () => {
      const conn = createMockConnection();
      await guard.sudoDeleteFile(conn, '/tmp/file', 'pass', false);
      expect((conn as any).sudoDeleteFile).toHaveBeenCalledWith('/tmp/file', 'pass', false);
    });

    it('sudoDeleteFile should pass isDirectory flag', async () => {
      const conn = createMockConnection();
      await guard.sudoDeleteFile(conn, '/opt/dir', 'pass', true);
      expect((conn as any).sudoDeleteFile).toHaveBeenCalledWith('/opt/dir', 'pass', true);
    });

    it('sudoMkdir should call connection.sudoMkdir', async () => {
      const conn = createMockConnection();
      await guard.sudoMkdir(conn, '/opt/newdir', 'pass');
      expect((conn as any).sudoMkdir).toHaveBeenCalledWith('/opt/newdir', 'pass');
    });

    it('sudoRename should call connection.sudoRename', async () => {
      const conn = createMockConnection();
      await guard.sudoRename(conn, '/old', '/new', 'pass');
      expect((conn as any).sudoRename).toHaveBeenCalledWith('/old', '/new', 'pass');
    });

    it('sudoWriteFile should fail activity on error', async () => {
      const conn = createMockConnection({
        sudoWriteFile: jest.fn().mockRejectedValue(new Error('incorrect password')),
      });
      await expect(guard.sudoWriteFile(conn, '/etc/x', Buffer.from(''), 'bad')).rejects.toThrow('incorrect password');
      const activities = activityService.getAllActivities();
      expect(activities[0].status).toBe('failed');
    });
  });
});
