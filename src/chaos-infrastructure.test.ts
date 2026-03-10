/**
 * Tests for chaos testing infrastructure:
 * - withTimeout utility
 * - ContainerHealthMonitor
 * - ChaosEngine timeout/skip/termination logic
 * - ChaosLogger report fields
 */

import { withTimeout } from './chaos/chaos-helpers';
import { ContainerHealthMonitor, ContainerDeathEvent } from './chaos/ContainerHealthMonitor';
import { ChaosLogger } from './chaos/ChaosLogger';
import { ChaosRunResult } from './chaos/ChaosConfig';

// Mock child_process.exec for ContainerHealthMonitor
jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: (fn: any) => {
    return (...args: any[]) => {
      return new Promise((resolve, reject) => {
        fn(...args, (err: any, stdout: any, stderr: any) => {
          if (err) reject(err);
          else resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
      });
    };
  },
}));

const { exec: mockExec } = require('child_process');

// ============================================================
// withTimeout
// ============================================================

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(
      Promise.resolve('done'),
      1000,
      'test'
    );
    expect(result).toBe('done');
  });

  it('rejects with timeout error when promise takes too long', async () => {
    // Use a flag-based promise to avoid dangling setTimeout handles
    let resolveSlowPromise: (v: string) => void;
    const slowPromise = new Promise<string>((resolve) => {
      resolveSlowPromise = resolve;
    });

    await expect(
      withTimeout(slowPromise, 50, 'slow-op')
    ).rejects.toThrow('Timeout after 50ms: slow-op');

    // Resolve to clean up
    resolveSlowPromise!('late');
  });

  it('forwards rejection from the original promise', async () => {
    const failingPromise = Promise.reject(new Error('original error'));

    await expect(
      withTimeout(failingPromise, 1000, 'test')
    ).rejects.toThrow('original error');
  });

  it('clears timeout when promise resolves quickly', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.resolve(42), 10000, 'test');

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears timeout when promise rejects quickly', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.reject(new Error('fail')), 10000, 'test').catch(() => {});

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('handles zero-delay resolution', async () => {
    const result = await withTimeout(Promise.resolve('instant'), 100, 'test');
    expect(result).toBe('instant');
  });

  it('includes label in timeout error message', async () => {
    const slowPromise = new Promise(() => {}); // never resolves

    try {
      await withTimeout(slowPromise, 10, 'my-operation-label');
      fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('my-operation-label');
      expect((err as Error).message).toContain('10ms');
    }
  });
});

// ============================================================
// ContainerHealthMonitor
// ============================================================

describe('ContainerHealthMonitor', () => {
  const testServers = [
    { label: 'prod-server', os: 'Alpine', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', hostname: 'prod-server', shell: 'ash' as const, group: 'basic' as const },
    { label: 'ubuntu-server', os: 'Ubuntu', host: '127.0.0.1', port: 2211, username: 'testuser', password: 'testpass', hostname: 'ubuntu-server', shell: 'bash' as const, group: 'multios' as const },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockDockerInspect(containerName: string, state: any) {
    (mockExec as jest.Mock).mockImplementation((cmd: string, opts: any, callback: Function) => {
      if (cmd.includes('docker inspect') && cmd.includes(containerName)) {
        callback(null, JSON.stringify(state), '');
      } else if (cmd.includes('docker inspect')) {
        callback(null, JSON.stringify({ Status: 'running', Running: true, ExitCode: 0 }), '');
      } else if (cmd.includes('docker logs')) {
        callback(null, 'some log output', '');
      } else {
        callback(new Error('unknown command'));
      }
    });
  }

  function mockAllRunning() {
    (mockExec as jest.Mock).mockImplementation((cmd: string, opts: any, callback: Function) => {
      if (cmd.includes('docker inspect')) {
        callback(null, JSON.stringify({ Status: 'running', Running: true, ExitCode: 0 }), '');
      } else if (cmd.includes('docker logs')) {
        callback(null, 'log output', '');
      } else {
        callback(new Error('unknown'));
      }
    });
  }

  function mockContainerDead(containerName: string, exitCode: number) {
    (mockExec as jest.Mock).mockImplementation((cmd: string, opts: any, callback: Function) => {
      if (cmd.includes('docker inspect') && cmd.includes(containerName)) {
        callback(null, JSON.stringify({ Status: 'exited', Running: false, ExitCode: exitCode }), '');
      } else if (cmd.includes('docker inspect')) {
        callback(null, JSON.stringify({ Status: 'running', Running: true, ExitCode: 0 }), '');
      } else if (cmd.includes('docker logs')) {
        callback(null, 'fatal error in sshd', '');
      } else {
        callback(new Error('unknown'));
      }
    });
  }

  function mockDockerNotAvailable() {
    (mockExec as jest.Mock).mockImplementation((cmd: string, opts: any, callback: Function) => {
      callback(new Error('Cannot connect to Docker daemon'));
    });
  }

  describe('constructor', () => {
    it('maps server labels to container names', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      expect((monitor as any).monitoredContainers.size).toBe(2);
      expect((monitor as any).monitoredContainers.get('prod-server')).toBe('sshlite-test-server-1');
      expect((monitor as any).monitoredContainers.get('ubuntu-server')).toBe('sshlite-os-ubuntu');
    });

    it('ignores servers with unknown labels', () => {
      const unknownServer = { ...testServers[0], label: 'unknown-server' };
      const monitor = new ContainerHealthMonitor([unknownServer]);
      expect((monitor as any).monitoredContainers.size).toBe(0);
    });
  });

  describe('preFlightCheck', () => {
    it('returns empty array when all containers are running', async () => {
      mockAllRunning();
      const monitor = new ContainerHealthMonitor(testServers);
      const failed = await monitor.preFlightCheck();
      expect(failed).toHaveLength(0);
    });

    it('returns non-running containers', async () => {
      mockContainerDead('sshlite-test-server-1', 137);
      const monitor = new ContainerHealthMonitor(testServers);
      const failed = await monitor.preFlightCheck();
      expect(failed).toHaveLength(1);
      expect(failed[0].serverLabel).toBe('prod-server');
      expect(failed[0].status).toBe('exited');
    });

    it('populates lastKnownStatuses cache', async () => {
      mockAllRunning();
      const monitor = new ContainerHealthMonitor(testServers);
      await monitor.preFlightCheck();
      expect((monitor as any).lastKnownStatuses.size).toBe(2);
    });

    it('handles Docker not available gracefully', async () => {
      mockDockerNotAvailable();
      const monitor = new ContainerHealthMonitor(testServers);
      const failed = await monitor.preFlightCheck();
      // All containers should be 'error' status = not running
      expect(failed).toHaveLength(2);
      expect(failed[0].status).toBe('error');
    });
  });

  describe('stop', () => {
    it('clears the poll interval', () => {
      const monitor = new ContainerHealthMonitor(testServers);

      // Simulate start() by setting the interval directly (avoids async checkAll leaks)
      (monitor as any).pollInterval = setInterval(() => {}, 60000);
      expect((monitor as any).pollInterval).not.toBeNull();

      monitor.stop();
      expect((monitor as any).pollInterval).toBeNull();
    });

    it('returns health report', async () => {
      mockAllRunning();
      const monitor = new ContainerHealthMonitor(testServers);
      await monitor.preFlightCheck(); // populate cache
      const report = monitor.stop();

      expect(report.monitored).toBe(2);
      expect(report.healthy).toBe(2);
      expect(report.dead).toBe(0);
      expect(report.deaths).toHaveLength(0);
    });

    it('is safe to call twice', async () => {
      mockAllRunning();
      const monitor = new ContainerHealthMonitor(testServers);
      await monitor.preFlightCheck();
      const report1 = monitor.stop();
      const report2 = monitor.stop();

      expect(report1.monitored).toBe(report2.monitored);
      expect(report1.healthy).toBe(report2.healthy);
    });

    it('does not re-query Docker on second call', async () => {
      mockAllRunning();
      const monitor = new ContainerHealthMonitor(testServers);
      await monitor.preFlightCheck();

      const callsBefore = (mockExec as jest.Mock).mock.calls.length;
      monitor.stop();
      const callsAfterFirst = (mockExec as jest.Mock).mock.calls.length;
      monitor.stop();
      const callsAfterSecond = (mockExec as jest.Mock).mock.calls.length;

      // No new Docker calls on stop (uses cache)
      expect(callsAfterFirst).toBe(callsBefore);
      expect(callsAfterSecond).toBe(callsBefore);
    });
  });

  describe('onDeath callback', () => {
    it('fires when container transitions from running to dead', async () => {
      const deathEvents: ContainerDeathEvent[] = [];
      const monitor = new ContainerHealthMonitor(testServers);
      monitor.onDeath((event) => deathEvents.push(event));

      // First check: all running
      mockAllRunning();
      await monitor.preFlightCheck();

      // Second check: prod-server died
      mockContainerDead('sshlite-test-server-1', 137);
      await (monitor as any).checkAll();

      expect(deathEvents).toHaveLength(1);
      expect(deathEvents[0].container).toBe('sshlite-test-server-1');
      expect(deathEvents[0].serverLabel).toBe('prod-server');
      expect(deathEvents[0].exitCode).toBe(137);
    });

    it('fires on first check if container is already dead', async () => {
      const deathEvents: ContainerDeathEvent[] = [];
      const monitor = new ContainerHealthMonitor(testServers);
      monitor.onDeath((event) => deathEvents.push(event));

      // First check: prod-server already dead
      mockContainerDead('sshlite-test-server-1', 1);
      await (monitor as any).checkAll();

      expect(deathEvents).toHaveLength(1);
      expect(deathEvents[0].exitCode).toBe(1);
    });

    it('does not fire death for transient Docker errors on first check', async () => {
      const deathEvents: ContainerDeathEvent[] = [];
      const monitor = new ContainerHealthMonitor(testServers);
      monitor.onDeath((event) => deathEvents.push(event));

      // First check: Docker returns error (not 'exited' or 'dead')
      mockDockerNotAvailable();
      await (monitor as any).checkAll();

      // Should NOT fire death — 'error' is transient, not a confirmed death
      expect(deathEvents).toHaveLength(0);
    });

    it('does not fire twice for the same death', async () => {
      const deathEvents: ContainerDeathEvent[] = [];
      const monitor = new ContainerHealthMonitor(testServers);
      monitor.onDeath((event) => deathEvents.push(event));

      mockContainerDead('sshlite-test-server-1', 137);
      await (monitor as any).checkAll();
      await (monitor as any).checkAll();

      // Only fires once (first check sets lastKnownStatuses, second sees no transition)
      expect(deathEvents).toHaveLength(1);
    });
  });

  describe('analyzeDeath', () => {
    it('identifies OOM kill from exit code 137', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      const analysis = (monitor as any).analyzeDeath('test', 'test-server',
        { exitCode: 137 }, 'normal log');
      expect(analysis).toContain('OOM killed');
      expect(analysis).toContain('exit 137');
    });

    it('identifies segfault from exit code 139', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      const analysis = (monitor as any).analyzeDeath('test', 'test-server',
        { exitCode: 139 }, 'normal log');
      expect(analysis).toContain('Segfault');
    });

    it('detects OOM from log patterns', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      const analysis = (monitor as any).analyzeDeath('test', 'test-server',
        { exitCode: 1 }, 'process killed: out of memory');
      expect(analysis).toContain('OOM condition');
      expect(analysis).toContain('CHAOS LIKELY CAUSE');
    });

    it('detects file descriptor exhaustion from logs', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      const analysis = (monitor as any).analyzeDeath('test', 'test-server',
        { exitCode: 1 }, 'error: too many open files');
      expect(analysis).toContain('file descriptor exhaustion');
      expect(analysis).toContain('CHAOS LIKELY CAUSE');
    });

    it('handles unknown exit code', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      const analysis = (monitor as any).analyzeDeath('test', 'test-server',
        { exitCode: 42 }, 'log');
      expect(analysis).toContain('Unknown exit code 42');
    });

    it('handles undefined exit code', () => {
      const monitor = new ContainerHealthMonitor(testServers);
      const analysis = (monitor as any).analyzeDeath('test', 'test-server',
        {}, 'log');
      expect(analysis).toContain('Unknown exit code -1');
    });
  });

  describe('checking guard', () => {
    it('prevents overlapping poll cycles', async () => {
      mockAllRunning();
      const monitor = new ContainerHealthMonitor(testServers);

      // Set checking flag manually
      (monitor as any).checking = true;
      await (monitor as any).checkAll();

      // Should have been a no-op (no Docker calls since guard prevented it)
      // The initial mock setup doesn't have calls from this invocation
      expect((mockExec as jest.Mock).mock.calls.length).toBe(0);
    });
  });
});

// ============================================================
// ChaosLogger - report fields
// ============================================================

describe('ChaosLogger report fields', () => {
  it('includes scenarios_skipped in buildRunResult', () => {
    const logger = new ChaosLogger();
    const result = logger.buildRunResult('quick', 42, 1000, [], [], []);

    expect(result.scenarios_skipped).toBe(0);
    expect(result.post_run_analysis).toEqual([]);
    expect(result.container_health).toBeDefined();
  });

  it('includes early_termination when set on result', () => {
    const logger = new ChaosLogger();
    const result = logger.buildRunResult('quick', 42, 1000, [], [], []);

    result.early_termination = {
      reason: 'global_timeout',
      message: 'Global time budget exceeded',
    };
    result.scenarios_skipped = 50;

    expect(result.early_termination.reason).toBe('global_timeout');
    expect(result.scenarios_skipped).toBe(50);
  });

  it('printSummary shows early termination info', () => {
    const logger = new ChaosLogger();
    const result = logger.buildRunResult('quick', 42, 5000, [], [], []);
    result.early_termination = {
      reason: 'global_timeout',
      message: 'Budget exceeded after 100 scenarios',
    };
    result.scenarios_skipped = 20;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    logger.printSummary(result);

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('EARLY TERMINATION');
    expect(output).toContain('global_timeout');
    expect(output).toContain('Budget exceeded');
    expect(output).toContain('20 skipped');

    consoleSpy.mockRestore();
  });

  it('printSummary shows skipped count in total line', () => {
    const logger = new ChaosLogger();
    const result = logger.buildRunResult('quick', 42, 1000, [], [], []);
    result.scenarios_skipped = 15;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    logger.printSummary(result);

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('15 skipped');

    consoleSpy.mockRestore();
  });

  it('printSummary omits skipped when zero', () => {
    const logger = new ChaosLogger();
    const result = logger.buildRunResult('quick', 42, 1000, [], [], []);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    logger.printSummary(result);

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).not.toContain('skipped');

    consoleSpy.mockRestore();
  });

  it('printSummary shows container deaths', () => {
    const logger = new ChaosLogger();
    const result = logger.buildRunResult('quick', 42, 1000, [], [], [], {
      monitored: 2,
      healthy: 1,
      dead: 1,
      deaths: [{
        timestamp: Date.now(),
        container: 'sshlite-test-server-1',
        serverLabel: 'prod-server',
        exitCode: 137,
        lastLogs: 'oom killed\nprocess terminated',
        analysis: 'OOM killed (exit 137)',
      }],
      containerStatuses: [],
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    logger.printSummary(result);

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('CONTAINER DEATHS (1)');
    expect(output).toContain('sshlite-test-server-1');
    expect(output).toContain('exit code 137');
    expect(output).toContain('Monitored: 2');
    expect(output).toContain('Dead: 1');

    consoleSpy.mockRestore();
  });
});

// ============================================================
// ChaosRunResult type completeness
// ============================================================

describe('ChaosRunResult type', () => {
  it('has all required fields for a complete report', () => {
    const result: ChaosRunResult = {
      timestamp: new Date().toISOString(),
      mode: 'quick',
      seed: 42,
      client_os: 'win32',
      duration_ms: 1000,
      servers_tested: [{ label: 'test', os: 'Alpine', port: 2201 }],
      scenarios_run: 10,
      passed: 8,
      failed: 2,
      failures: [],
      per_os_summary: { Alpine: { run: 10, passed: 8, failed: 2 } },
      anomalies_detected: [],
      coverage: {
        actions_exercised: ['exec'],
        actions_missed: ['searchFiles'],
        methods_uncovered: [],
        invariants_checked: 50,
        invariants_violated: 1,
      },
      output_summary: {},
      container_health: { monitored: 1, healthy: 1, dead: 0, deaths: [], containerStatuses: [] },
      scenarios_skipped: 5,
      early_termination: {
        reason: 'global_timeout',
        message: 'Budget exceeded',
      },
      post_run_analysis: ['Pass rate: 80%'],
    };

    expect(result.scenarios_skipped).toBe(5);
    expect(result.early_termination?.reason).toBe('global_timeout');
    expect(result.post_run_analysis).toHaveLength(1);
  });

  it('early_termination is optional', () => {
    const result: ChaosRunResult = {
      timestamp: new Date().toISOString(),
      mode: 'deep',
      seed: 1,
      client_os: 'linux',
      duration_ms: 500,
      servers_tested: [],
      scenarios_run: 0,
      passed: 0,
      failed: 0,
      failures: [],
      per_os_summary: {},
      anomalies_detected: [],
      coverage: {
        actions_exercised: [],
        actions_missed: [],
        methods_uncovered: [],
        invariants_checked: 0,
        invariants_violated: 0,
      },
      output_summary: {},
      container_health: { monitored: 0, healthy: 0, dead: 0, deaths: [], containerStatuses: [] },
      scenarios_skipped: 0,
      post_run_analysis: [],
    };

    expect(result.early_termination).toBeUndefined();
  });
});
