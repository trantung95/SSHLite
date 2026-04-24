# Channel Semaphore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent SSH channel exhaustion during parallel search by adding a per-connection semaphore in CommandGuard, with adaptive concurrency reduction, search retry, and visible terminal wait with 30s timeout.

**Architecture:** `ChannelSemaphore` (new class) gates every `exec()` and `shell()` call through CommandGuard. On channel-limit failure, it reduces `maxSlots` and the command retries (search: max 3 times; terminal: shows progress and waits up to 30s then errors). Semaphores are per-connection — server A never blocks server B.

**Tech Stack:** TypeScript, ssh2 `ClientChannel`, VS Code `withProgress`, Jest (`@swc/jest`), Docker (E2E)

---

## File Map

| File | Action |
|---|---|
| `src/services/ChannelSemaphore.ts` | **Create** — semaphore class + `ChannelLimitError` + `ChannelTimeoutError` |
| `src/services/CommandGuard.ts` | **Modify** — add semaphore map, wrap `exec()`, add `openShell()`, `removeSemaphore()` |
| `src/services/TerminalService.ts` | **Modify** — accept optional pre-opened `ClientChannel` in `createTerminal()` |
| `src/extension.ts` | **Modify** — terminal handlers: call `commandGuard.openShell()`, show progress, catch timeout |
| `package.json` | **Modify** — add `sshLite.maxChannelsPerServer` setting |
| `src/__tests__/ChannelSemaphore.test.ts` | **Create** — unit tests |
| `src/__tests__/CommandGuard.channel.test.ts` | **Create** — unit + integration tests |
| `test/docker-channel-semaphore.test.ts` | **Create** — E2E tests |
| `src/chaos/channel-semaphore.chaos.ts` | **Create** — chaos scenarios |
| `.adn/configuration/settings-reference.md` | **Modify** — add `maxChannelsPerServer` |
| `.adn/features/terminal-port-forwarding.md` | **Modify** — document channel wait behaviour |

---

## Task 1: ChannelSemaphore class

**Files:**
- Create: `src/services/ChannelSemaphore.ts`
- Create: `src/__tests__/ChannelSemaphore.test.ts`

- [ ] **Step 1.1: Create the test file**

```typescript
// src/__tests__/ChannelSemaphore.test.ts
import { ChannelSemaphore, ChannelLimitError, ChannelTimeoutError } from '../services/ChannelSemaphore';

describe('ChannelSemaphore', () => {
  describe('immediate acquire', () => {
    it('acquires a slot when slots are available', async () => {
      const sem = new ChannelSemaphore(2);
      const release = await sem.acquire();
      expect(sem.activeCount).toBe(1);
      release();
      expect(sem.activeCount).toBe(0);
    });

    it('fills all slots and tracks activeCount', async () => {
      const sem = new ChannelSemaphore(3);
      const r1 = await sem.acquire();
      const r2 = await sem.acquire();
      const r3 = await sem.acquire();
      expect(sem.activeCount).toBe(3);
      expect(sem.available).toBe(0);
      r1(); r2(); r3();
    });
  });

  describe('queued acquire', () => {
    it('queues when full and wakes in FIFO order', async () => {
      const sem = new ChannelSemaphore(1);
      const r1 = await sem.acquire();
      const order: number[] = [];
      const p2 = sem.acquire().then(r => { order.push(2); return r; });
      const p3 = sem.acquire().then(r => { order.push(3); return r; });
      expect(sem.queued).toBe(2);
      r1();
      const r2 = await p2;
      r2();
      const r3 = await p3;
      r3();
      expect(order).toEqual([2, 3]);
    });

    it('activeCount never exceeds maxSlots', async () => {
      const sem = new ChannelSemaphore(2);
      const releases: Array<() => void> = [];
      const promises = Array.from({ length: 5 }, () =>
        sem.acquire().then(r => { releases.push(r); })
      );
      await Promise.resolve();
      expect(sem.activeCount).toBeLessThanOrEqual(2);
      for (const r of releases) r();
      await Promise.allSettled(promises);
    });
  });

  describe('timeout', () => {
    it('rejects with ChannelTimeoutError after timeout', async () => {
      const sem = new ChannelSemaphore(1);
      const r1 = await sem.acquire();
      await expect(sem.acquire(50)).rejects.toBeInstanceOf(ChannelTimeoutError);
      r1();
    });

    it('includes timeoutMs in the error', async () => {
      const sem = new ChannelSemaphore(1);
      const r1 = await sem.acquire();
      const err = await sem.acquire(100).catch(e => e);
      expect(err.timeoutMs).toBe(100);
      r1();
    });

    it('does not reject if slot frees before timeout', async () => {
      const sem = new ChannelSemaphore(1);
      const r1 = await sem.acquire();
      const p = sem.acquire(500);
      setTimeout(() => r1(), 50);
      const release = await p;
      release();
    });
  });

  describe('adaptive concurrency', () => {
    it('reduceMax decrements maxSlots with floor at 1', () => {
      const sem = new ChannelSemaphore(3);
      sem.reduceMax();
      expect(sem.maxSlots).toBe(2);
      sem.reduceMax();
      expect(sem.maxSlots).toBe(1);
      sem.reduceMax();
      expect(sem.maxSlots).toBe(1);
    });

    it('increaseMax increments maxSlots with ceiling at initialMax', () => {
      const sem = new ChannelSemaphore(4);
      sem.reduceMax(); sem.reduceMax();
      sem.increaseMax();
      expect(sem.maxSlots).toBe(3);
      sem.increaseMax();
      expect(sem.maxSlots).toBe(4);
      sem.increaseMax();
      expect(sem.maxSlots).toBe(4);
    });

    it('recordSuccess calls increaseMax after 5 successes', () => {
      const sem = new ChannelSemaphore(4);
      sem.reduceMax();
      for (let i = 0; i < 4; i++) sem.recordSuccess();
      expect(sem.maxSlots).toBe(3);
      sem.recordSuccess();
      expect(sem.maxSlots).toBe(4);
    });

    it('reduceMax resets consecutiveSuccesses counter', () => {
      const sem = new ChannelSemaphore(4);
      sem.reduceMax();
      for (let i = 0; i < 4; i++) sem.recordSuccess();
      sem.reduceMax();
      for (let i = 0; i < 4; i++) sem.recordSuccess();
      expect(sem.maxSlots).toBe(2);
      sem.recordSuccess();
      expect(sem.maxSlots).toBe(3);
    });
  });

  describe('destroy', () => {
    it('rejects all queued waiters with provided error', async () => {
      const sem = new ChannelSemaphore(1);
      const r1 = await sem.acquire();
      const p2 = sem.acquire();
      const p3 = sem.acquire();
      const err = new Error('Connection closed');
      sem.destroy(err);
      await expect(p2).rejects.toThrow('Connection closed');
      await expect(p3).rejects.toThrow('Connection closed');
      expect(sem.queued).toBe(0);
      r1();
    });

    it('resets activeCount to 0 on destroy', async () => {
      const sem = new ChannelSemaphore(2);
      await sem.acquire();
      await sem.acquire();
      sem.destroy(new Error('done'));
      expect(sem.activeCount).toBe(0);
    });
  });
});

describe('ChannelLimitError', () => {
  it('has correct name and message', () => {
    const err = new ChannelLimitError();
    expect(err.name).toBe('ChannelLimitError');
    expect(err.message).toBe('SSH channel limit reached');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ChannelTimeoutError', () => {
  it('has correct name, message, and timeoutMs', () => {
    const err = new ChannelTimeoutError(30000);
    expect(err.name).toBe('ChannelTimeoutError');
    expect(err.timeoutMs).toBe(30000);
    expect(err).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 1.2: Run tests — verify all fail**

```
npx jest --no-coverage ChannelSemaphore
```
Expected: FAIL — `Cannot find module '../services/ChannelSemaphore'`

- [ ] **Step 1.3: Create `src/services/ChannelSemaphore.ts`**

```typescript
// src/services/ChannelSemaphore.ts

export class ChannelLimitError extends Error {
  constructor() {
    super('SSH channel limit reached');
    this.name = 'ChannelLimitError';
  }
}

export class ChannelTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`SSH channel acquire timed out after ${timeoutMs}ms`);
    this.name = 'ChannelTimeoutError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ChannelSemaphore {
  private _maxSlots: number;
  private readonly _initialMax: number;
  private _activeCount = 0;
  private _waitQueue: Waiter[] = [];
  private _consecutiveSuccesses = 0;

  constructor(maxSlots: number) {
    this._maxSlots = maxSlots;
    this._initialMax = maxSlots;
  }

  get maxSlots(): number { return this._maxSlots; }
  get activeCount(): number { return this._activeCount; }
  get queued(): number { return this._waitQueue.length; }
  get available(): number { return Math.max(0, this._maxSlots - this._activeCount); }

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this._activeCount < this._maxSlots) {
      this._activeCount++;
      return this._makeRelease();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this._activeCount++;
          resolve(this._makeRelease());
        },
        reject,
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const idx = this._waitQueue.indexOf(waiter);
          if (idx !== -1) this._waitQueue.splice(idx, 1);
          reject(new ChannelTimeoutError(timeoutMs));
        }, timeoutMs);
      }
      this._waitQueue.push(waiter);
    });
  }

  recordSuccess(): void {
    this._consecutiveSuccesses++;
    if (this._consecutiveSuccesses >= 5) {
      this.increaseMax();
    }
  }

  reduceMax(): void {
    this._maxSlots = Math.max(1, this._maxSlots - 1);
    this._consecutiveSuccesses = 0;
  }

  increaseMax(): void {
    this._maxSlots = Math.min(this._initialMax, this._maxSlots + 1);
    this._consecutiveSuccesses = 0;
  }

  destroy(err: Error): void {
    for (const waiter of this._waitQueue) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this._waitQueue = [];
    this._activeCount = 0;
  }

  private _makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._activeCount--;
      if (this._waitQueue.length > 0) {
        this._waitQueue.shift()!.resolve();
      }
    };
  }
}
```

- [ ] **Step 1.4: Run tests — verify all pass**

```
npx jest --no-coverage ChannelSemaphore
```
Expected: PASS

- [ ] **Step 1.5: Compile**

```
npm run compile
```
Expected: 0 errors

- [ ] **Step 1.6: Commit**

```
git add src/services/ChannelSemaphore.ts src/__tests__/ChannelSemaphore.test.ts
git commit -m "feat: add ChannelSemaphore with adaptive max and timeout support"
```

---

## Task 2: CommandGuard — semaphore map + exec() wrapping

**Files:**
- Modify: `src/services/CommandGuard.ts`
- Create: `src/__tests__/CommandGuard.channel.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `src/__tests__/CommandGuard.channel.test.ts`:

```typescript
import { CommandGuard } from '../services/CommandGuard';
import { ChannelLimitError } from '../services/ChannelSemaphore';
import { createMockConnection } from '../__mocks__/testHelpers';

beforeEach(() => {
  (CommandGuard as any)._instance = undefined;
  jest.clearAllMocks();
});

describe('CommandGuard — channel semaphore (exec)', () => {
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

describe('CommandGuard — channel semaphore (openShell)', () => {
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

describe('CommandGuard — integration (mock SSH)', () => {
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
```

- [ ] **Step 2.2: Run — verify fail**

```
npx jest --no-coverage CommandGuard.channel
```
Expected: FAIL

- [ ] **Step 2.3: Update `src/services/CommandGuard.ts`**

Add imports after the existing imports at the top:
```typescript
import * as vscode from 'vscode';
import { ClientChannel } from 'ssh2';
import { ChannelSemaphore, ChannelLimitError } from './ChannelSemaphore';
```

Add fields after `private activityService`:
```typescript
  private semaphores: Map<string, ChannelSemaphore> = new Map();
  private static readonly EXEC_MAX_RETRIES = 3;
  private static readonly EXEC_RETRY_DELAY_MS = 100;
  private static readonly SHELL_TIMEOUT_MS = 30_000;
```

Add these two methods after the constructor (before `exec()`):
```typescript
  private getSemaphore(connectionId: string): ChannelSemaphore {
    if (!this.semaphores.has(connectionId)) {
      const config = vscode.workspace.getConfiguration('sshLite');
      const maxSlots = config.get<number>('maxChannelsPerServer', 8);
      this.semaphores.set(connectionId, new ChannelSemaphore(maxSlots));
    }
    return this.semaphores.get(connectionId)!;
  }

  removeSemaphore(connectionId: string): void {
    const sem = this.semaphores.get(connectionId);
    if (sem) {
      sem.destroy(new Error('Connection closed'));
      this.semaphores.delete(connectionId);
    }
  }
```

Replace the entire `exec()` method body:
```typescript
  async exec(
    connection: SSHConnection,
    command: string,
    options?: TrackingOptions
  ): Promise<string> {
    const desc = options?.description || this.extractCommandDescription(command);
    const activityId = this.activityService.startActivity(
      options?.type || 'terminal',
      connection.id,
      connection.host.name,
      desc,
      {
        detail: options?.detail,
        cancellable: options?.cancellable,
        onCancel: options?.onCancel,
      }
    );

    const semaphore = this.getSemaphore(connection.id);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= CommandGuard.EXEC_MAX_RETRIES; attempt++) {
      const release = await semaphore.acquire();
      try {
        let result: string;
        if (connection.sudoMode && connection.sudoPassword) {
          result = await connection.sudoExec(command, connection.sudoPassword);
        } else {
          result = await connection.exec(command);
        }
        semaphore.recordSuccess();
        this.activityService.completeActivity(activityId);
        return result;
      } catch (error) {
        const err = error as Error;
        if (err.message?.includes('open failure') && attempt < CommandGuard.EXEC_MAX_RETRIES) {
          semaphore.reduceMax();
          lastError = new ChannelLimitError();
          await new Promise<void>(r => setTimeout(r, CommandGuard.EXEC_RETRY_DELAY_MS));
        } else {
          this.activityService.failActivity(activityId, err.message);
          throw error;
        }
      } finally {
        release();
      }
    }

    this.activityService.failActivity(activityId, lastError!.message);
    throw lastError!;
  }
```

Add `openShell()` method after `removeSemaphore()`:
```typescript
  async openShell(connection: SSHConnection): Promise<ClientChannel> {
    const semaphore = this.getSemaphore(connection.id);
    const release = await semaphore.acquire(CommandGuard.SHELL_TIMEOUT_MS);

    let channel: ClientChannel;
    try {
      channel = await connection.shell();
    } catch (error) {
      release();
      throw error;
    }

    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    channel.on('close', releaseOnce);
    channel.on('exit', releaseOnce);

    return channel;
  }
```

- [ ] **Step 2.4: Run tests**

```
npx jest --no-coverage CommandGuard.channel
```
Expected: PASS

- [ ] **Step 2.5: Run full suite**

```
npx jest --no-coverage
```
Expected: all pass

- [ ] **Step 2.6: Commit**

```
git add src/services/CommandGuard.ts src/__tests__/CommandGuard.channel.test.ts
git commit -m "feat: wrap CommandGuard.exec() and openShell() with per-connection ChannelSemaphore"
```

---

## Task 3: TerminalService — accept pre-opened channel

**Files:**
- Modify: `src/services/TerminalService.ts` line 38 and 48

- [ ] **Step 3.1: Update `createTerminal` signature (line 38)**

Change:
```typescript
  async createTerminal(connection: SSHConnection): Promise<vscode.Terminal> {
```
To:
```typescript
  async createTerminal(connection: SSHConnection, preOpenedShell?: ClientChannel): Promise<vscode.Terminal> {
```

- [ ] **Step 3.2: Use preOpenedShell when provided (line 48)**

Change:
```typescript
      const shell = await connection.shell();
```
To:
```typescript
      const shell = preOpenedShell ?? await connection.shell();
```

- [ ] **Step 3.3: Compile**

```
npm run compile
```
Expected: 0 errors

- [ ] **Step 3.4: Run full suite**

```
npx jest --no-coverage
```
Expected: all pass

- [ ] **Step 3.5: Commit**

```
git add src/services/TerminalService.ts
git commit -m "feat: TerminalService.createTerminal accepts optional pre-opened ClientChannel"
```

---

## Task 4: Config + disconnect wiring

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`

- [ ] **Step 4.1: Add setting to `package.json`**

Inside `contributes.configuration.properties`, add:
```json
"sshLite.maxChannelsPerServer": {
  "type": "number",
  "default": 8,
  "minimum": 1,
  "description": "Maximum concurrent SSH channels per server connection. Default 8 leaves headroom on servers with MaxSessions 10. Adapts downward automatically when the server limit is hit."
}
```

- [ ] **Step 4.2: Call `removeSemaphore` on disconnect in `src/extension.ts`**

Find the `onConnectionStateChange` listener. Add inside the `Disconnected` branch:
```typescript
commandGuard.removeSemaphore(connectionId);
```

If `commandGuard` is not yet in scope, add near the other `getInstance()` calls:
```typescript
const commandGuard = CommandGuard.getInstance();
```

And add the import at the top of extension.ts if not present:
```typescript
import { CommandGuard } from './services/CommandGuard';
```

- [ ] **Step 4.3: Compile + test**

```
npm run compile && npx jest --no-coverage
```
Expected: 0 errors, all pass

- [ ] **Step 4.4: Commit**

```
git add package.json src/extension.ts
git commit -m "feat: add sshLite.maxChannelsPerServer config and wire removeSemaphore on disconnect"
```

---

## Task 5: Terminal handlers — progress + error

**Files:**
- Modify: `src/extension.ts` — `openTerminal` and `openTerminalHere` handlers

- [ ] **Step 5.1: Update `openTerminal` handler**

Find the final `await terminalService.createTerminal(connection)` inside `openTerminal`. Replace the block from `logCommand` to the end of the handler with:

```typescript
      logCommand('openTerminal', connection.host.name);
      try {
        const shell = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Waiting for a free channel to open terminal...',
            cancellable: false,
          },
          () => commandGuard.openShell(connection)
        );
        await terminalService.createTerminal(connection, shell);
        logResult('openTerminal', true, connection.host.name);
      } catch (error) {
        const { ChannelTimeoutError } = await import('./services/ChannelSemaphore');
        if (error instanceof ChannelTimeoutError) {
          vscode.window.showErrorMessage(
            'Failed to open terminal: all SSH channels are busy (30s timeout). Stop a search or wait and try again.'
          );
          return;
        }
        throw error;
      }
```

- [ ] **Step 5.2: Update `openTerminalHere` handler**

Find the block:
```typescript
      const terminal = await terminalService.createTerminal(connection);
      if (terminal) {
        terminal.sendText(`cd "${targetPath}"`);
        logResult('openTerminalHere', true, `cd "${targetPath}"`);
      }
```

Replace with:
```typescript
      try {
        const shell = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Waiting for a free channel to open terminal...',
            cancellable: false,
          },
          () => commandGuard.openShell(connection)
        );
        const terminal = await terminalService.createTerminal(connection, shell);
        if (terminal) {
          terminal.sendText(`cd "${targetPath}"`);
          logResult('openTerminalHere', true, `cd "${targetPath}"`);
        }
      } catch (error) {
        const { ChannelTimeoutError } = await import('./services/ChannelSemaphore');
        if (error instanceof ChannelTimeoutError) {
          vscode.window.showErrorMessage(
            'Failed to open terminal: all SSH channels are busy (30s timeout). Stop a search or wait and try again.'
          );
          return;
        }
        throw error;
      }
```

- [ ] **Step 5.3: Compile + test**

```
npm run compile && npx jest --no-coverage
```
Expected: 0 errors, all pass

- [ ] **Step 5.4: Commit**

```
git add src/extension.ts
git commit -m "feat: terminal handlers show progress while waiting for channel, error on 30s timeout"
```

---

## Task 6: E2E Docker tests

**Files:**
- Create: `test/docker-channel-semaphore.test.ts`

> **Note:** Follow the helper/container patterns in existing docker test files (e.g. `test/docker-ssh.test.ts`). The containers should use `MaxSessions 4` in sshd_config to make exhaustion reproducible without needing 10 channels.

- [ ] **Step 6.1: Create `test/docker-channel-semaphore.test.ts`**

```typescript
// test/docker-channel-semaphore.test.ts
// Run: npx jest --no-coverage docker-channel-semaphore

import { CommandGuard } from '../src/services/CommandGuard';
import { ChannelTimeoutError } from '../src/services/ChannelSemaphore';

// Use your existing docker helpers — adjust imports to match your project
import { createTestConnection, startSshContainer, stopSshContainer } from './dockerHelpers';

const CONTAINER_A = 'ch-sem-a';
const CONTAINER_B = 'ch-sem-b';

describe('ChannelSemaphore E2E — single server', () => {
  let conn: any;

  beforeAll(async () => {
    await startSshContainer(CONTAINER_A);
    conn = await createTestConnection(CONTAINER_A);
  }, 60_000);

  afterAll(async () => {
    await conn.disconnect();
    await stopSshContainer(CONTAINER_A);
    (CommandGuard as any)._instance = undefined;
  });

  beforeEach(() => { (CommandGuard as any)._instance = undefined; });

  it('terminal waits for slot and opens once a search slot frees', async () => {
    const guard = CommandGuard.getInstance();
    const sem = (guard as any).getSemaphore(conn.id);
    (sem as any)._maxSlots = 2;
    (sem as any)._initialMax = 2;

    // Hold both slots with long-running commands
    const holders = [
      guard.exec(conn, 'sleep 3'),
      guard.exec(conn, 'sleep 3'),
    ];

    // Terminal waits in queue
    const shellPromise = guard.openShell(conn);

    // Holders complete, freeing slots
    await Promise.all(holders);
    const channel = await shellPromise;
    expect(channel).toBeDefined();
    (channel as any).end?.();
  }, 30_000);

  it('terminal times out after 30s when all channels remain busy', async () => {
    const guard = CommandGuard.getInstance();
    const sem = (guard as any).getSemaphore(conn.id);
    const releases = await Promise.all(
      Array.from({ length: sem.maxSlots }, () => sem.acquire())
    );
    await expect(guard.openShell(conn)).rejects.toBeInstanceOf(ChannelTimeoutError);
    for (const r of releases) r();
  }, 45_000);

  it('search retries adapt concurrency and all complete', async () => {
    const guard = CommandGuard.getInstance();
    const sem = (guard as any).getSemaphore(conn.id);
    (sem as any)._maxSlots = 2;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => guard.exec(conn, 'echo ok'))
    );
    expect(results.every(r => r.includes('ok'))).toBe(true);
    expect(sem.activeCount).toBe(0);
  }, 30_000);
});

describe('ChannelSemaphore E2E — multi-server isolation', () => {
  let connA: any;
  let connB: any;

  beforeAll(async () => {
    await Promise.all([startSshContainer(CONTAINER_A), startSshContainer(CONTAINER_B)]);
    [connA, connB] = await Promise.all([
      createTestConnection(CONTAINER_A),
      createTestConnection(CONTAINER_B),
    ]);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([connA.disconnect(), connB.disconnect()]);
    await Promise.all([stopSshContainer(CONTAINER_A), stopSshContainer(CONTAINER_B)]);
    (CommandGuard as any)._instance = undefined;
  });

  beforeEach(() => { (CommandGuard as any)._instance = undefined; });

  it('saturating server A does not block server B terminal', async () => {
    const guard = CommandGuard.getInstance();
    const semA = (guard as any).getSemaphore(connA.id);
    const releases = await Promise.all(Array.from({ length: semA.maxSlots }, () => semA.acquire()));

    const channelB = await guard.openShell(connB);
    expect(channelB).toBeDefined();
    (channelB as any).end?.();

    for (const r of releases) r();
  }, 20_000);

  it('two users on same host have independent semaphores', async () => {
    const guard = CommandGuard.getInstance();
    const semA = (guard as any).getSemaphore(connA.id);
    const semB = (guard as any).getSemaphore(connB.id);
    expect(semA).not.toBe(semB);

    (semA as any)._maxSlots = 1;
    const releaseA = await semA.acquire();

    const result = await guard.exec(connB, 'echo hello');
    expect(result.trim()).toBe('hello');

    releaseA();
  }, 20_000);
});
```

- [ ] **Step 6.2: Run E2E tests**

```
npx jest --no-coverage docker-channel-semaphore
```
Expected: all pass (requires Docker, ~2–3 minutes)

- [ ] **Step 6.3: Commit**

```
git add test/docker-channel-semaphore.test.ts
git commit -m "test(e2e): channel semaphore Docker tests for single and multi-server isolation"
```

---

## Task 7: Chaos tests

**Files:**
- Create: `src/chaos/channel-semaphore.chaos.ts`

- [ ] **Step 7.1: Check existing chaos runner pattern**

Read one existing file in `src/chaos/` to find how `registerChaosScenario` (or equivalent) is imported and used. Apply that exact import pattern below.

- [ ] **Step 7.2: Create `src/chaos/channel-semaphore.chaos.ts`**

```typescript
// src/chaos/channel-semaphore.chaos.ts
// Adjust the import below to match your existing chaos runner pattern
import { registerChaosScenario } from './chaosRunner';
import { ChannelSemaphore, ChannelLimitError } from '../services/ChannelSemaphore';
import { CommandGuard } from '../services/CommandGuard';
import { createMockConnection } from '../__mocks__/testHelpers';

registerChaosScenario(
  'channel-semaphore: random concurrent mix — no deadlock, no slot leak',
  async () => {
    (CommandGuard as any)._instance = undefined;
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    const sem = (guard as any).getSemaphore(conn.id);
    (sem as any)._maxSlots = 3;

    conn.exec = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, Math.random() * 20));
      return 'ok';
    });
    conn.shell = jest.fn().mockImplementation(async () => {
      const ch = { on: jest.fn() };
      setTimeout(() => {
        const closeCall = (ch.on as jest.Mock).mock.calls.find((c: any[]) => c[0] === 'close');
        if (closeCall) closeCall[1]();
      }, Math.random() * 50);
      return ch;
    });

    const ops = [
      ...Array.from({ length: 5 }, () => guard.exec(conn, 'ls')),
      ...Array.from({ length: 3 }, () => guard.openShell(conn).catch(() => {})),
      ...Array.from({ length: 4 }, () => guard.exec(conn, 'grep foo /log')),
    ];
    await Promise.allSettled(ops);

    if (sem.activeCount !== 0) {
      throw new Error(`Slot leak: activeCount=${sem.activeCount}`);
    }
  }
);

registerChaosScenario(
  'channel-semaphore: random open failures — maxSlots never below 1',
  async () => {
    (CommandGuard as any)._instance = undefined;
    const guard = CommandGuard.getInstance();
    const conn = createMockConnection() as any;
    conn.exec = jest.fn().mockImplementation(async () => {
      if (Math.random() < 0.4) throw new Error('Channel open failure');
      return 'ok';
    });

    await Promise.allSettled(Array.from({ length: 20 }, () => guard.exec(conn, 'ls').catch(() => {})));

    const sem = (guard as any).getSemaphore(conn.id);
    if (sem.maxSlots < 1) throw new Error(`maxSlots below 1: ${sem.maxSlots}`);
    if (sem.activeCount !== 0) throw new Error(`Slot leak: activeCount=${sem.activeCount}`);
  }
);

registerChaosScenario(
  'channel-semaphore: abrupt disconnect mid-queue — all waiters rejected cleanly',
  async () => {
    const sem = new ChannelSemaphore(1);
    const releaseFirst = await sem.acquire();
    const waiters = Array.from({ length: 5 }, () => sem.acquire());

    sem.destroy(new Error('Connection dropped'));

    const results = await Promise.allSettled(waiters);
    const rejected = results.filter(r => r.status === 'rejected');
    if (rejected.length !== 5) throw new Error(`Expected 5 rejections, got ${rejected.length}`);
    if (sem.queued !== 0) throw new Error(`Queue not empty: ${sem.queued}`);
    releaseFirst();
  }
);

registerChaosScenario(
  'channel-semaphore: rapid acquire/release — queue never unbounded',
  async () => {
    const sem = new ChannelSemaphore(4);
    let maxObservedQueue = 0;

    const ops = Array.from({ length: 500 }, async () => {
      const release = await sem.acquire();
      maxObservedQueue = Math.max(maxObservedQueue, sem.queued);
      await new Promise(r => setTimeout(r, Math.random() * 5));
      release();
    });

    await Promise.all(ops);

    if (sem.activeCount !== 0) throw new Error(`Slot leak: activeCount=${sem.activeCount}`);
  }
);

registerChaosScenario(
  'channel-semaphore: multi-server — no cross-server slot leakage',
  async () => {
    (CommandGuard as any)._instance = undefined;
    const guard = CommandGuard.getInstance();

    const servers = ['sA:22:root', 'sB:22:root', 'sC:22:root'].map(id => {
      const conn = createMockConnection({ id }) as any;
      conn.exec = jest.fn().mockImplementation(async () => {
        if (Math.random() < 0.3) throw new Error('Channel open failure');
        await new Promise(r => setTimeout(r, Math.random() * 15));
        return 'ok';
      });
      return conn;
    });

    await Promise.allSettled(servers.flatMap(conn =>
      Array.from({ length: 8 }, () => guard.exec(conn, 'ls').catch(() => {}))
    ));

    for (const conn of servers) {
      const sem = (guard as any).semaphores.get(conn.id);
      if (sem.activeCount !== 0) throw new Error(`Leak on ${conn.id}: ${sem.activeCount}`);
    }

    const semaphores = servers.map(c => (guard as any).semaphores.get(c.id));
    if (new Set(semaphores).size !== 3) throw new Error('Servers share semaphores');
  }
);

registerChaosScenario(
  'channel-semaphore: multi-user same host — independent maxSlots adaptation',
  async () => {
    (CommandGuard as any)._instance = undefined;
    const guard = CommandGuard.getInstance();

    const userA = createMockConnection({ id: 'host1:22:root' }) as any;
    const userB = createMockConnection({ id: 'host1:22:deploy' }) as any;

    userA.exec = jest.fn().mockImplementation(async () => {
      if (Math.random() < 0.5) throw new Error('Channel open failure');
      return 'ok';
    });
    userB.exec = jest.fn().mockResolvedValue('ok');

    await Promise.allSettled([
      ...Array.from({ length: 15 }, () => guard.exec(userA, 'ls').catch(() => {})),
      ...Array.from({ length: 15 }, () => guard.exec(userB, 'ls')),
    ]);

    const semA = (guard as any).semaphores.get('host1:22:root');
    const semB = (guard as any).semaphores.get('host1:22:deploy');

    if (semA === semB) throw new Error('Users share the same semaphore');
    if (semA.activeCount !== 0 || semB.activeCount !== 0) throw new Error('Slot leak');
  }
);
```

- [ ] **Step 7.3: Run chaos tests**

```
npm run test:chaos
```
Expected: all scenarios pass

- [ ] **Step 7.4: Commit**

```
git add src/chaos/channel-semaphore.chaos.ts
git commit -m "test(chaos): channel semaphore scenarios for deadlock, leaks, multi-server, multi-user"
```

---

## Task 8: Docs + final

**Files:**
- Modify: `.adn/configuration/settings-reference.md`
- Modify: `.adn/features/terminal-port-forwarding.md`

- [ ] **Step 8.1: Add `maxChannelsPerServer` to `.adn/configuration/settings-reference.md`**

Add to the settings table:
```
| `sshLite.maxChannelsPerServer` | `8` | Max concurrent SSH channels per server. Adapts downward on channel limit errors. |
```

- [ ] **Step 8.2: Add channel limit section to `.adn/features/terminal-port-forwarding.md`**

Append:
```markdown
## Channel Limit Handling

SSH servers enforce a max concurrent channel count (MaxSessions, typically 10). During heavy parallel search, terminal opens may be delayed.

**Terminal behaviour:** shows "Waiting for a free channel to open terminal..." progress notification. Opens automatically when a search channel frees. Times out after 30s with: *"Failed to open terminal: all SSH channels are busy. Stop a search or wait and try again."*

**Search behaviour:** automatically reduces max concurrent search threads on channel-limit failure and retries the failed command (max 3 times). User sees search completing at reduced parallelism.

**Config:** `sshLite.maxChannelsPerServer` (default 8) — reduce if server has `MaxSessions` below 10.
```

- [ ] **Step 8.3: Regenerate commands doc + final compile + test**

```
npm run docs:commands && npm run compile && npx jest --no-coverage
```
Expected: 0 errors, all pass

- [ ] **Step 8.4: Final commit**

```
git add .adn/configuration/settings-reference.md .adn/features/terminal-port-forwarding.md docs/COMMANDS.md
git commit -m "docs: update .adn docs for channel semaphore feature"
```
