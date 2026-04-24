import { CommandGuard } from '../services/CommandGuard';
import { ChannelLimitError } from '../services/ChannelSemaphore';
import { createMockConnection } from '../__mocks__/testHelpers';

beforeEach(() => {
  (CommandGuard as any)._instance = undefined;
  jest.clearAllMocks();
});

describe('CommandGuard channel semaphore (exec)', () => {
  it('creates a semaphore per connection on first exec', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockResolvedValue('ok');
    await guard.exec(conn, 'echo hi');
    const sem = (guard as any).getSemaphore(conn.id);
    expect(sem).toBeDefined();
  });

  it('exec() succeeds and releases the slot', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockResolvedValue('output');
    const result = await guard.exec(conn, 'echo hi');
    expect(result).toBe('output');
    const sem = (guard as any).getSemaphore(conn.id);
    expect(sem.activeCount).toBe(0);
  });

  it('exec() retries up to 3 times on open failure and eventually succeeds', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn()
      .mockRejectedValueOnce(new Error('Channel open failure'))
      .mockRejectedValueOnce(new Error('Channel open failure'))
      .mockResolvedValueOnce('ok');
    const result = await guard.exec(conn, 'grep foo /var/log');
    expect(result).toBe('ok');
    expect(conn.exec).toHaveBeenCalledTimes(3);
  });

  it('exec() throws ChannelLimitError after 3 failed retries', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockRejectedValue(new Error('Channel open failure'));
    await expect(guard.exec(conn, 'grep foo /var/log')).rejects.toBeInstanceOf(ChannelLimitError);
    expect(conn.exec).toHaveBeenCalledTimes(4);
  });

  it('exec() reduces semaphore maxSlots on open failure', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockRejectedValue(new Error('Channel open failure'));
    const sem = (guard as any).getSemaphore(conn.id);
    const initialMax = sem.maxSlots;
    await guard.exec(conn, 'grep foo').catch(() => {});
    expect(sem.maxSlots).toBeLessThan(initialMax);
  });

  it('exec() releases the slot even when it throws', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockRejectedValue(new Error('some error'));
    await guard.exec(conn, 'bad cmd').catch(() => {});
    const sem = (guard as any).getSemaphore(conn.id);
    expect(sem.activeCount).toBe(0);
  });

  it('semaphores are independent per connection', async () => {
    const guard = CommandGuard.getInstance();
    const connA = createMockConnection({ id: 'a:22:root' }) as any;
    const connB = createMockConnection({ id: 'b:22:root' }) as any;
    connA.exec = jest.fn().mockResolvedValue('a');
    connB.exec = jest.fn().mockResolvedValue('b');
    await Promise.all([guard.exec(connA, 'ls'), guard.exec(connB, 'ls')]);
    const semA = (guard as any).semaphores.get('a:22:root');
    const semB = (guard as any).semaphores.get('b:22:root');
    expect(semA).not.toBe(semB);
  });

  it('removeSemaphore destroys and deletes the semaphore', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockResolvedValue('ok');
    await guard.exec(conn, 'ls');
    guard.removeSemaphore(conn.id);
    expect((guard as any).semaphores.has(conn.id)).toBe(false);
  });
});

describe('CommandGuard channel semaphore (openShell)', () => {
  it('openShell() acquires a slot and returns the channel', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    const fakeChannel = { on: jest.fn() };
    conn.shell = jest.fn().mockResolvedValue(fakeChannel);
    const channel = await guard.openShell(conn);
    expect(channel).toBe(fakeChannel);
    const sem = (guard as any).getSemaphore(conn.id);
    expect(sem.activeCount).toBe(1);
  });

  it('openShell() releases slot when channel emits close', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    let closeHandler: (() => void) | undefined;
    const fakeChannel = {
      on: jest.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      }),
    };
    conn.shell = jest.fn().mockResolvedValue(fakeChannel);
    await guard.openShell(conn);
    const sem = (guard as any).getSemaphore(conn.id);
    expect(sem.activeCount).toBe(1);
    closeHandler!();
    expect(sem.activeCount).toBe(0);
  });

  it('openShell() does not double-release on close + exit', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    const handlers: Record<string, () => void> = {};
    const fakeChannel = {
      on: jest.fn((event: string, handler: () => void) => { handlers[event] = handler; }),
    };
    conn.shell = jest.fn().mockResolvedValue(fakeChannel);
    await guard.openShell(conn);
    const sem = (guard as any).getSemaphore(conn.id);
    handlers['close']();
    handlers['exit']();
    expect(sem.activeCount).toBe(0);
  });

  it('openShell() releases immediately if shell() throws', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.shell = jest.fn().mockRejectedValue(new Error('shell failed'));
    await expect(guard.openShell(conn)).rejects.toThrow('shell failed');
    const sem = (guard as any).getSemaphore(conn.id);
    expect(sem.activeCount).toBe(0);
  });
});

describe('CommandGuard integration (mock SSH)', () => {
  it('N concurrent execs all complete when maxSlots < N', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    let concurrentPeak = 0;
    let current = 0;
    conn.exec = jest.fn().mockImplementation(async () => {
      current++;
      concurrentPeak = Math.max(concurrentPeak, current);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return 'ok';
    });
    const sem = (guard as any).getSemaphore(conn.id);
    (sem as any)._maxSlots = 2;
    (sem as any)._initialMax = 2;
    const results = await Promise.all(Array.from({ length: 6 }, () => guard.exec(conn, 'ls')));
    expect(results).toHaveLength(6);
    expect(concurrentPeak).toBeLessThanOrEqual(2);
    expect(sem.activeCount).toBe(0);
  });

  it('per-connection isolation: server A failure does not affect server B', async () => {
    const guard = CommandGuard.getInstance();
    const connA = createMockConnection({ id: 'serverA:22:root' }) as any;
    const connB = createMockConnection({ id: 'serverB:22:root' }) as any;
    connA.exec = jest.fn().mockRejectedValue(new Error('Channel open failure'));
    connB.exec = jest.fn().mockResolvedValue('b-result');
    await guard.exec(connA, 'ls').catch(() => {});
    const result = await guard.exec(connB, 'ls');
    expect(result).toBe('b-result');
  });

  it('removeSemaphore rejects queued waiters cleanly', async () => {
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockImplementation(() => new Promise(() => {}));
    const sem = (guard as any).getSemaphore(conn.id);
    (sem as any)._maxSlots = 1;
    guard.exec(conn, 'ls').catch(() => {});
    await Promise.resolve();
    const p2 = guard.exec(conn, 'ls');
    guard.removeSemaphore(conn.id);
    await expect(p2).rejects.toThrow('Connection closed');
  });
});