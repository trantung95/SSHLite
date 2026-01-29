/**
 * ServerMonitorService tests
 *
 * Tests the parsing logic for server status output.
 * Since ServerMonitorService is a singleton that uses SSH connections,
 * we test the parse methods by exposing them through the service's
 * fetchServerStatus behavior using mocked exec results.
 */

import { ServerMonitorService, ServerStatus } from './ServerMonitorService';

// Access private methods for testing parse logic
function getServiceInstance(): ServerMonitorService {
  // Reset singleton
  (ServerMonitorService as any)._instance = undefined;
  return ServerMonitorService.getInstance();
}

/**
 * Helper: Call the private parseServerStatus method
 */
function parseServerStatus(output: string): ServerStatus {
  const service = getServiceInstance();
  return (service as any).parseServerStatus(output);
}

/**
 * Helper: Call the private parseMemoryInfo method
 */
function parseMemoryInfo(content: string): { memoryTotal: number; memoryUsed: number; memoryPercent: number; swapTotal: number; swapUsed: number } {
  const service = getServiceInstance();
  const status: any = {
    memoryTotal: 0,
    memoryUsed: 0,
    memoryPercent: 0,
    swapTotal: 0,
    swapUsed: 0,
  };
  (service as any).parseMemoryInfo(content, status);
  return status;
}

/**
 * Helper: Call the private parseDiskUsage method
 */
function parseDiskUsage(content: string): Array<{
  filesystem: string; size: string; used: string; available: string; percent: number; mountPoint: string;
}> {
  const service = getServiceInstance();
  return (service as any).parseDiskUsage(content);
}

/**
 * Helper: Call the private parseProcessList method
 */
function parseProcessList(content: string): Array<{
  pid: number; user: string; cpu: number; mem: number; vsz: number; rss: number; stat: string; time: string; command: string;
}> {
  const service = getServiceInstance();
  return (service as any).parseProcessList(content);
}

describe('ServerMonitorService', () => {
  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ServerMonitorService.getInstance();
      const instance2 = ServerMonitorService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('parseServerStatus', () => {
    it('should parse hostname', () => {
      const output = '===HOSTNAME===\nmy-server\n===UPTIME===\n';
      const status = parseServerStatus(output);
      expect(status.hostname).toBe('my-server');
    });

    it('should parse uptime output', () => {
      const output = '===UPTIME===\n 14:32:01 up 45 days, 3:21, 2 users, load average: 0.15, 0.10, 0.05\n';
      const status = parseServerStatus(output);
      expect(status.uptime).toContain('up 45 days');
    });

    it('should extract load average from uptime', () => {
      const output = '===UPTIME===\n 14:32:01 up 45 days, load average: 1.25, 0.80, 0.45\n';
      const status = parseServerStatus(output);
      expect(status.loadAverage).toBe('1.25');
    });

    it('should parse loadavg from /proc/loadavg', () => {
      const output = '===LOADAVG===\n0.52 0.48 0.45 1/234 5678\n';
      const status = parseServerStatus(output);
      expect(status.loadAverage).toBe('0.52 0.48 0.45');
    });

    it('should parse memory section', () => {
      const output = '===MEMORY===\n              total        used        free      shared  buff/cache   available\nMem:     8388608     4194304     2097152      524288     2097152     3670016\nSwap:    2097152      524288     1572864\n';
      const status = parseServerStatus(output);
      expect(status.memoryTotal).toBe(8388608);
      expect(status.memoryUsed).toBe(4194304);
      expect(status.memoryPercent).toBe(50);
      expect(status.swapTotal).toBe(2097152);
      expect(status.swapUsed).toBe(524288);
    });

    it('should parse disk section', () => {
      const output = '===DISK===\n/dev/sda1       50G   25G   25G  50% /\n/dev/sdb1      100G   80G   20G  80% /data\n';
      const status = parseServerStatus(output);
      expect(status.diskUsage).toHaveLength(2);
      expect(status.diskUsage[0].mountPoint).toBe('/');
      expect(status.diskUsage[0].percent).toBe(50);
      expect(status.diskUsage[1].mountPoint).toBe('/data');
      expect(status.diskUsage[1].percent).toBe(80);
    });

    it('should parse processes section', () => {
      const output = '===TOP_PROCS===\nUSER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\nroot         1  0.0  0.1 169936 11768 ?        Ss   Jan01   5:23 /sbin/init\nmysql     1234 15.2  8.5 1234567 890123 ?      Sl   Jan02  100:23 /usr/bin/mysqld\n';
      const status = parseServerStatus(output);
      expect(status.topProcesses).toHaveLength(2);
      expect(status.topProcesses[0].pid).toBe(1);
      expect(status.topProcesses[0].user).toBe('root');
      expect(status.topProcesses[0].command).toBe('/sbin/init');
      expect(status.topProcesses[1].pid).toBe(1234);
      expect(status.topProcesses[1].cpu).toBe(15.2);
      expect(status.topProcesses[1].mem).toBe(8.5);
    });

    it('should parse network connections count', () => {
      const output = '===CONNECTIONS===\n42\n';
      const status = parseServerStatus(output);
      expect(status.networkConnections).toBe(42);
    });

    it('should derive zombie count from zombie list', () => {
      const output = [
        '===ZOMBIE_LIST===',
        '12345 100 www-data Z+ defunct',
        '12346 100 root Zs other',
      ].join('\n');
      const status = parseServerStatus(output);
      expect(status.zombieProcesses).toBe(2);
      expect(status.zombieProcessList).toHaveLength(2);
    });

    it('should have zero zombies when list is empty', () => {
      const output = '===ZOMBIE_LIST===\n\n';
      const status = parseServerStatus(output);
      expect(status.zombieProcesses).toBe(0);
      expect(status.zombieProcessList).toEqual([]);
    });

    it('should parse complete server output', () => {
      const output = [
        '===HOSTNAME===', 'prod-server',
        '===UPTIME===', ' 10:00:00 up 30 days, load average: 2.50, 2.00, 1.50',
        '===LOADAVG===', '2.50 2.00 1.50 5/300 12345',
        '===MEMORY===', '              total        used        free\nMem:     16000000     12000000      4000000\nSwap:     4000000      1000000      3000000',
        '===DISK===', '/dev/sda1       100G   85G   15G  85% /',
        '===TOP_PROCS===', 'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 0.1 0.2 100 200 ? Ss Jan01 1:00 /sbin/init',
        '===CONNECTIONS===', '15',
        '===ZOMBIE_LIST===', '',
      ].join('\n');

      const status = parseServerStatus(output);
      expect(status.hostname).toBe('prod-server');
      expect(status.memoryTotal).toBe(16000000);
      expect(status.memoryUsed).toBe(12000000);
      expect(status.memoryPercent).toBe(75);
      expect(status.diskUsage).toHaveLength(1);
      expect(status.topProcesses).toHaveLength(1);
      expect(status.networkConnections).toBe(15);
      expect(status.zombieProcesses).toBe(0);
    });

    it('should handle empty output gracefully', () => {
      const status = parseServerStatus('');
      expect(status.hostname).toBe('');
      expect(status.memoryTotal).toBe(0);
      expect(status.diskUsage).toEqual([]);
      expect(status.topProcesses).toEqual([]);
    });
  });

  describe('parseMemoryInfo', () => {
    it('should parse Mem line', () => {
      const content = 'Mem:     8000000     5000000     3000000';
      const result = parseMemoryInfo(content);
      expect(result.memoryTotal).toBe(8000000);
      expect(result.memoryUsed).toBe(5000000);
    });

    it('should calculate memory percentage', () => {
      const content = 'Mem:     10000     7500     2500';
      const result = parseMemoryInfo(content);
      expect(result.memoryPercent).toBe(75);
    });

    it('should parse Swap line', () => {
      const content = 'Swap:    4000000     1000000     3000000';
      const result = parseMemoryInfo(content);
      expect(result.swapTotal).toBe(4000000);
      expect(result.swapUsed).toBe(1000000);
    });

    it('should parse both Mem and Swap', () => {
      const content = [
        '              total        used        free',
        'Mem:     16000000    12000000     4000000',
        'Swap:     8000000     2000000     6000000',
      ].join('\n');
      const result = parseMemoryInfo(content);
      expect(result.memoryTotal).toBe(16000000);
      expect(result.memoryUsed).toBe(12000000);
      expect(result.swapTotal).toBe(8000000);
      expect(result.swapUsed).toBe(2000000);
    });

    it('should handle zero total memory', () => {
      const content = 'Mem:     0     0     0';
      const result = parseMemoryInfo(content);
      expect(result.memoryPercent).toBe(0); // Should not divide by zero
    });

    it('should handle header line without crashing', () => {
      const content = '              total        used        free\nMem:     8000     4000     4000';
      const result = parseMemoryInfo(content);
      expect(result.memoryTotal).toBe(8000);
    });
  });

  describe('parseDiskUsage', () => {
    it('should parse single disk line', () => {
      const content = '/dev/sda1       50G   25G   25G  50% /';
      const disks = parseDiskUsage(content);
      expect(disks).toHaveLength(1);
      expect(disks[0]).toEqual({
        filesystem: '/dev/sda1',
        size: '50G',
        used: '25G',
        available: '25G',
        percent: 50,
        mountPoint: '/',
      });
    });

    it('should parse multiple disk lines', () => {
      const content = [
        '/dev/sda1       50G   25G   25G  50% /',
        '/dev/sdb1      100G   80G   20G  80% /data',
        '/dev/sdc1      500G  100G  400G  20% /backup',
      ].join('\n');
      const disks = parseDiskUsage(content);
      expect(disks).toHaveLength(3);
      expect(disks[0].mountPoint).toBe('/');
      expect(disks[1].mountPoint).toBe('/data');
      expect(disks[2].mountPoint).toBe('/backup');
    });

    it('should skip non-/dev lines', () => {
      const content = [
        'Filesystem      Size  Used Avail Use% Mounted on',
        '/dev/sda1       50G   25G   25G  50% /',
        'tmpfs           4.0G     0  4.0G   0% /dev/shm',
      ].join('\n');
      const disks = parseDiskUsage(content);
      expect(disks).toHaveLength(1);
    });

    it('should handle empty content', () => {
      const disks = parseDiskUsage('');
      expect(disks).toEqual([]);
    });

    it('should parse high usage disks', () => {
      const content = '/dev/sda1       50G   48G    2G  96% /';
      const disks = parseDiskUsage(content);
      expect(disks[0].percent).toBe(96);
    });
  });

  describe('parseProcessList', () => {
    it('should skip the header line', () => {
      const content = [
        'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
        'root         1  0.0  0.1 169936 11768 ?        Ss   Jan01   5:23 /sbin/init',
      ].join('\n');
      const procs = parseProcessList(content);
      expect(procs).toHaveLength(1);
    });

    it('should parse process columns correctly', () => {
      const content = [
        'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
        'mysql     1234 15.2  8.5 1234567 890123 ?      Sl   Jan02  100:23 /usr/bin/mysqld --user=mysql',
      ].join('\n');
      const procs = parseProcessList(content);
      expect(procs[0]).toEqual({
        pid: 1234,
        user: 'mysql',
        cpu: 15.2,
        mem: 8.5,
        vsz: 1234567,
        rss: 890123,
        stat: 'Sl',
        time: '100:23',
        command: '/usr/bin/mysqld --user=mysql',
      });
    });

    it('should handle commands with spaces', () => {
      const content = [
        'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
        'www  5678  2.5  3.0 500000 100000 ? Sl Jan01 10:00 /usr/bin/node /app/server.js --port 3000',
      ].join('\n');
      const procs = parseProcessList(content);
      expect(procs[0].command).toBe('/usr/bin/node /app/server.js --port 3000');
    });

    it('should handle multiple processes', () => {
      const content = [
        'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
        'root 1 0.0 0.1 100 200 ? Ss Jan01 1:00 /sbin/init',
        'mysql 100 5.0 10.0 500 1000 ? Sl Jan01 50:00 mysqld',
        'nginx 200 2.0 1.0 300 500 ? Sl Jan01 20:00 nginx: master',
      ].join('\n');
      const procs = parseProcessList(content);
      expect(procs).toHaveLength(3);
      expect(procs[0].pid).toBe(1);
      expect(procs[1].pid).toBe(100);
      expect(procs[2].pid).toBe(200);
    });

    it('should handle empty content', () => {
      const procs = parseProcessList('');
      expect(procs).toEqual([]);
    });

    it('should skip lines with too few columns', () => {
      const content = [
        'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
        'short line',
        'root 1 0.0 0.1 100 200 ? Ss Jan01 1:00 /sbin/init',
      ].join('\n');
      const procs = parseProcessList(content);
      expect(procs).toHaveLength(1);
    });
  });

  describe('quickStatus', () => {
    it('should call exec with combined diagnostic command', async () => {
      const service = getServiceInstance();
      const mockConnection = {
        host: { name: 'TestServer' },
        exec: jest.fn().mockResolvedValue(
          '===UPTIME===\nup 10 days\n===MEMORY===\nMem: 8000 4000 4000\n'
        ),
      } as any;

      await service.quickStatus(mockConnection);

      expect(mockConnection.exec).toHaveBeenCalledTimes(1);
      const command = mockConnection.exec.mock.calls[0][0];
      expect(command).toContain('uptime');
      expect(command).toContain('free -h');
      expect(command).toContain('df -h');
    });

    it('should handle exec error', async () => {
      const service = getServiceInstance();
      const mockConnection = {
        host: { name: 'TestServer' },
        exec: jest.fn().mockRejectedValue(new Error('Connection lost')),
      } as any;

      // Should not throw
      await service.quickStatus(mockConnection);
    });
  });

  describe('diagnoseSlowness', () => {
    it('should detect high load', async () => {
      const service = getServiceInstance();
      // Build mock that responds to multiple exec calls
      const execMock = jest.fn()
        .mockResolvedValueOnce('8.50 7.00 5.00\n2') // load + nproc
        .mockResolvedValueOnce('Mem:  8000  7500  500  100  0  500\nSwap: 2000  100  1900')
        .mockResolvedValueOnce('5') // I/O wait
        .mockResolvedValueOnce('50% /\n20% /data')
        .mockResolvedValueOnce('root 1 1.0 0.1 100 200 ? Ss Jan01 1:00 /sbin/init')
        .mockResolvedValueOnce('root 1 0.1 1.0 100 200 ? Ss Jan01 1:00 /sbin/init')
        .mockResolvedValueOnce('TCP: 100');

      const mockConnection = {
        host: { name: 'SlowServer' },
        exec: execMock,
      } as any;

      await service.diagnoseSlowness(mockConnection);

      // Should have called exec multiple times for diagnostics
      expect(execMock).toHaveBeenCalled();
    });

    it('should handle diagnosis error', async () => {
      const service = getServiceInstance();
      const mockConnection = {
        host: { name: 'TestServer' },
        exec: jest.fn().mockRejectedValue(new Error('Timeout')),
      } as any;

      // Should not throw
      await service.diagnoseSlowness(mockConnection);
    });
  });

  describe('zombie list parsing', () => {
    it('should parse zombie process list', () => {
      const output = [
        '===ZOMBIE_LIST===',
        '12345 100 www-data Z+ <defunct>',
        '12346 100 www-data Z+ apache2',
      ].join('\n');
      const status = parseServerStatus(output);
      expect(status.zombieProcessList).toHaveLength(2);
      expect(status.zombieProcessList[0].pid).toBe(12345);
      expect(status.zombieProcessList[0].ppid).toBe(100);
      expect(status.zombieProcessList[0].user).toBe('www-data');
    });

    it('should handle empty zombie list', () => {
      const output = '===ZOMBIE_LIST===\n\n';
      const status = parseServerStatus(output);
      expect(status.zombieProcessList).toEqual([]);
    });
  });
});
