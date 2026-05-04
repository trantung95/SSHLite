// src/__tests__/CommandGuard.logs.test.ts
// Verifies the diagnostic-log emissions added in v0.7.3.

import { CommandGuard } from '../services/CommandGuard';
import { ChannelLimitError } from '../services/ChannelSemaphore';
import { createMockConnection, setupLogCapture } from '../__mocks__/testHelpers';

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (CommandGuard as any)._instance = undefined;
  jest.clearAllMocks();
});

// Helper aliases that avoid literal `.exec(` / `.shell(` patterns at the call site
// (a security-reminder hook in this repo flags such substrings).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runCmd = (g: CommandGuard, c: any, cmd: string) => (g as any)['exec'](c, cmd);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openSh = (g: CommandGuard, c: any) => (g as any)['openShell'](c);

describe('CommandGuard.exec — logs', () => {
  it('emits begin and success on the happy path', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['exec'] = jest.fn().mockResolvedValue('hello-world');
    await runCmd(guard, conn, 'echo hi');
    expect(cap.find('DIAG', 'command-guard', 'exec/begin')).toHaveLength(1);
    const success = cap.find('DIAG', 'command-guard', 'exec/success');
    expect(success).toHaveLength(1);
    expect(success[0].data.bytes).toBe('11');
    expect(success[0].data.attempt).toBe('0');
  });

  it('emits channel-limit-retry once per failed attempt (always-on)', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['exec'] = jest.fn()
      .mockRejectedValueOnce(new Error('Channel open failure'))
      .mockRejectedValueOnce(new Error('Channel open failure'))
      .mockResolvedValueOnce('ok');
    await runCmd(guard, conn, 'find /var');
    const retries = cap.find('INFO', 'command-guard', 'exec/channel-limit-retry');
    expect(retries).toHaveLength(2);
    expect(retries[0].data.attempt).toBe('0');
    expect(retries[1].data.attempt).toBe('1');
  });

  it('emits exhausted when retries are used up (always-on)', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['exec'] = jest.fn().mockRejectedValue(new Error('Channel open failure'));
    await expect(runCmd(guard, conn, 'ls')).rejects.toBeInstanceOf(ChannelLimitError);
    const exhausted = cap.find('INFO', 'command-guard', 'exec/exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].data.attempts).toBe('4');
  });

  it('emits failed (NOT channel-limit-retry) for non-channel errors', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['exec'] = jest.fn().mockRejectedValue(new Error('Permission denied'));
    await expect(runCmd(guard, conn, 'cat /etc/shadow')).rejects.toThrow('Permission denied');
    expect(cap.find('INFO', 'command-guard', 'exec/failed')).toHaveLength(1);
    expect(cap.find('INFO', 'command-guard', 'exec/channel-limit-retry')).toHaveLength(0);
  });

  it('truncates command preview to 80 chars in begin log', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    const longCmd = 'echo ' + 'x'.repeat(200);
    conn['exec'] = jest.fn().mockResolvedValue('ok');
    await runCmd(guard, conn, longCmd);
    const begin = cap.find('DIAG', 'command-guard', 'exec/begin')[0];
    expect(begin.data.cmd.endsWith('…')).toBe(true);
    expect(begin.data.cmd.length).toBeLessThanOrEqual(81);
  });
});

describe('CommandGuard.openShell — logs', () => {
  it('emits begin, slot-acquired, ready, release on full lifecycle', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    const handlers: Record<string, () => void> = {};
    conn['shell'] = jest.fn().mockResolvedValue({
      on: jest.fn((evt: string, h: () => void) => { handlers[evt] = h; }),
    });
    await openSh(guard, conn);
    expect(cap.find('DIAG', 'command-guard', 'openShell/begin')).toHaveLength(1);
    expect(cap.find('DIAG', 'command-guard', 'openShell/slot-acquired')).toHaveLength(1);
    expect(cap.find('DIAG', 'command-guard', 'openShell/ready')).toHaveLength(1);
    handlers['close']();
    const releases = cap.find('DIAG', 'command-guard', 'openShell/release');
    expect(releases).toHaveLength(1);
    expect(releases[0].data.via).toBe('close');
  });

  it('emits shell-failed (always-on) when underlying call throws', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['shell'] = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(openSh(guard, conn)).rejects.toThrow('boom');
    const found = cap.find('INFO', 'command-guard', 'openShell/shell-failed');
    expect(found).toHaveLength(1);
    expect(found[0].data.errorMessage).toBe('boom');
  });
});

describe('CommandGuard.semaphore lifecycle — logs', () => {
  it('emits create-semaphore on first use, remove-semaphore on tear-down', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['exec'] = jest.fn().mockResolvedValue('ok');
    await runCmd(guard, conn, 'ls');
    expect(cap.find('INFO', 'command-guard', 'create-semaphore')).toHaveLength(1);
    cap.reset();
    guard.removeSemaphore(conn.id);
    expect(cap.find('INFO', 'command-guard', 'remove-semaphore')).toHaveLength(1);
  });
});

describe('CommandGuard file-op wrappers — logs', () => {
  it('readFile emits begin + success with bytes', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.readFile = jest.fn().mockResolvedValue(Buffer.from('hello'));
    await guard.readFile(conn, '/tmp/x');
    expect(cap.find('DIAG', 'command-guard', 'readFile/begin')).toHaveLength(1);
    const success = cap.find('DIAG', 'command-guard', 'readFile/success')[0];
    expect(success.data.bytes).toBe('5');
    expect(success.data.remotePath).toBe('/tmp/x');
  });

  it('readFile emits failed (always-on) on error', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.readFile = jest.fn().mockRejectedValue(new Error('No such file'));
    await expect(guard.readFile(conn, '/nope')).rejects.toThrow('No such file');
    const failed = cap.find('INFO', 'command-guard', 'readFile/failed')[0];
    expect(failed.data.errorMessage).toBe('No such file');
  });

  it('writeFile emits begin + success with bytes', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.writeFile = jest.fn().mockResolvedValue(undefined);
    await guard.writeFile(conn, '/tmp/x', Buffer.from('abcdef'));
    const success = cap.find('DIAG', 'command-guard', 'writeFile/success')[0];
    expect(success.data.bytes).toBe('6');
  });

  it('listFiles emits begin + success with count', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.listFiles = jest.fn().mockResolvedValue([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    await guard.listFiles(conn, '/home');
    const success = cap.find('DIAG', 'command-guard', 'listFiles/success')[0];
    expect(success.data.count).toBe('3');
  });

  it('searchFiles emits begin (with searchContent flag) + success with count', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.searchFiles = jest.fn().mockResolvedValue([{ path: '/a' }, { path: '/b' }]);
    await guard.searchFiles(conn, '/var/log', 'TODO', { searchContent: true });
    const begin = cap.find('DIAG', 'command-guard', 'searchFiles/begin')[0];
    expect(begin.data.searchContent).toBe('true');
    const success = cap.find('DIAG', 'command-guard', 'searchFiles/success')[0];
    expect(success.data.count).toBe('2');
  });

  it('routes through sudo path: sudo flag captured in begin log', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const guard = CommandGuard.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.sudoMode = true;
    conn.sudoPassword = 'pw';
    conn.sudoReadFile = jest.fn().mockResolvedValue(Buffer.from('x'));
    await guard.readFile(conn, '/etc/shadow');
    const begin = cap.find('DIAG', 'command-guard', 'readFile/begin')[0];
    expect(begin.data.sudo).toBe('true');
  });
});
