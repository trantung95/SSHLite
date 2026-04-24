/**
 * SystemToolsService tests
 */

import { SystemToolsService } from './SystemToolsService';

function reset(): SystemToolsService {
  (SystemToolsService as any)._instance = undefined;
  return SystemToolsService.getInstance();
}

function mockConnection() {
  return {
    id: 'test-1',
    host: { name: 'Test', host: 'test', port: 22, username: 'u' },
    state: 'connected',
    sudoMode: false,
    sudoPassword: null,
    exec: jest.fn().mockResolvedValue(''),
    sudoExec: jest.fn().mockResolvedValue(''),
  } as any;
}

describe('SystemToolsService', () => {
  let service: SystemToolsService;

  beforeEach(() => {
    service = reset();
  });

  describe('parseProcessOutput', () => {
    it('parses ps output into entries', () => {
      const raw = [
        '  PID USER     %CPU %MEM COMMAND',
        '  123 root     10.5  2.1 systemd',
        ' 4567 alice    50.0 20.0 node server.js',
      ].join('\n');
      const procs = service.parseProcessOutput(raw);
      expect(procs).toHaveLength(2);
      expect(procs[0]).toMatchObject({ pid: 123, user: 'root', cpu: 10.5, mem: 2.1, command: 'systemd' });
      expect(procs[1].command).toBe('node server.js');
    });

    it('skips rows with invalid PID', () => {
      const raw = 'PID USER %CPU %MEM COMMAND\nabc x y z bad\n123 ok 1 1 good';
      const procs = service.parseProcessOutput(raw);
      expect(procs).toHaveLength(1);
      expect(procs[0].pid).toBe(123);
    });

    it('parses busybox ps aux format (PID USER TIME COMMAND)', () => {
      const raw = [
        'PID   USER     TIME  COMMAND',
        '    1 root      0:00 /sbin/init',
        '  123 nginx     0:01 nginx: worker process',
        '  456 www-data  0:00 /usr/bin/php-fpm',
      ].join('\n');
      const procs = service.parseProcessOutput(raw);
      expect(procs).toHaveLength(3);
      expect(procs[0]).toMatchObject({ pid: 1, user: 'root', cpu: 0, mem: 0 });
      expect(procs[0].command).toContain('init');
      expect(procs[1].pid).toBe(123);
      expect(procs[1].command).toContain('nginx');
      // busybox provides no cpu/mem — both should be 0
      expect(procs.every((p) => p.cpu === 0 && p.mem === 0)).toBe(true);
    });

    it('parses GNU ps aux format (USER PID %CPU %MEM ... COMMAND)', () => {
      const raw = [
        'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
        'root           1  0.0  0.1   1068   648 ?        Ss   12:00   0:00 /sbin/init',
        'alice        999 12.5  5.3 512000 53888 pts/0    Sl   14:30   1:23 node server.js',
      ].join('\n');
      const procs = service.parseProcessOutput(raw);
      expect(procs).toHaveLength(2);
      expect(procs[0]).toMatchObject({ pid: 1, user: 'root', cpu: 0.0, mem: 0.1 });
      expect(procs[1]).toMatchObject({ pid: 999, user: 'alice', cpu: 12.5, mem: 5.3 });
    });

    it('returns empty array for empty input', () => {
      expect(service.parseProcessOutput('')).toEqual([]);
    });

    it('returns empty array for header-only input', () => {
      expect(service.parseProcessOutput('PID USER %CPU %MEM COMMAND\n')).toEqual([]);
    });
  });

  describe('parseServiceOutput', () => {
    it('parses systemctl list-units rows ending in .service', () => {
      const raw = [
        'sshd.service loaded active running OpenSSH server',
        'nginx.service loaded active running High performance web server',
        'notactual loaded inactive dead something',
      ].join('\n');
      const out = service.parseServiceOutput(raw);
      expect(out).toHaveLength(2);
      expect(out[0].name).toBe('sshd.service');
      expect(out[0].description).toBe('OpenSSH server');
    });
  });

  describe('listProcesses', () => {
    it('caps limit at 5000 and runs ps', async () => {
      const conn = mockConnection();
      conn.exec.mockResolvedValueOnce('PID USER %CPU %MEM COMMAND\n1 root 0 0 init');
      await service.listProcesses(conn, 10 ** 9);
      const cmd = conn.exec.mock.calls[0][0] as string;
      expect(cmd).toContain('head -5001');
    });

    it('uses fallback ps aux command structure', async () => {
      const conn = mockConnection();
      conn.exec.mockResolvedValueOnce('PID USER %CPU %MEM COMMAND\n1 root 0 0 init');
      await service.listProcesses(conn, 10);
      const cmd = conn.exec.mock.calls[0][0] as string;
      expect(cmd).toContain('ps -eo pid,user,%cpu,%mem,comm');
      expect(cmd).toContain('ps aux');
      expect(cmd).toContain('2>/dev/null');
    });

    it('clamps negative/NaN limits to 1', async () => {
      const conn = mockConnection();
      await service.listProcesses(conn, -5);
      const cmd = conn.exec.mock.calls[0][0] as string;
      expect(cmd).toContain('head -2');
    });
  });

  describe('killProcess', () => {
    it('uses kill -TERM by default', async () => {
      const conn = mockConnection();
      await service.killProcess(conn, 1234, false);
      expect(conn.exec).toHaveBeenCalledWith('kill -TERM 1234');
    });

    it('routes through sudoExec when useSudo', async () => {
      const conn = mockConnection();
      conn.sudoPassword = 'pw';
      await service.killProcess(conn, 1234, true);
      expect(conn.sudoExec).toHaveBeenCalledWith('kill -TERM 1234', 'pw');
    });

    it('rejects invalid PID', async () => {
      const conn = mockConnection();
      await expect(service.killProcess(conn, -1, false)).rejects.toThrow('Invalid PID');
      await expect(service.killProcess(conn, NaN, false)).rejects.toThrow('Invalid PID');
    });

    it('rejects non-alphanumeric signal', async () => {
      const conn = mockConnection();
      await expect(service.killProcess(conn, 1234, false, 'TERM; rm -rf /')).rejects.toThrow('Invalid signal');
    });
  });

  describe('runServiceAction', () => {
    it('rejects service names with shell metacharacters', async () => {
      const conn = mockConnection();
      await expect(service.runServiceAction(conn, 'bad; rm -rf /', 'status', false)).rejects.toThrow('Invalid service name');
    });

    it('accepts template units like getty@tty1.service', async () => {
      const conn = mockConnection();
      await service.runServiceAction(conn, 'getty@tty1.service', 'status', false);
      expect(conn.exec).toHaveBeenCalledWith('systemctl status getty@tty1.service');
    });

    it('uses sudoExec for non-status actions when useSudo', async () => {
      const conn = mockConnection();
      conn.sudoPassword = 'pw';
      await service.runServiceAction(conn, 'nginx.service', 'restart', true);
      expect(conn.sudoExec).toHaveBeenCalledWith('systemctl restart nginx.service', 'pw');
    });
  });
});
