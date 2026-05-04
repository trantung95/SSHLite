// src/__tests__/ChannelSemaphore.test.ts
import { ChannelSemaphore, ChannelLimitError, ChannelTimeoutError } from '../services/ChannelSemaphore';
import { setupLogCapture } from '../__mocks__/testHelpers';

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
      // Drain all 5 slots: release one-at-a-time and flush microtasks so
      // queued waiters can push their release fns before the next iteration.
      let idx = 0;
      while (idx < 5) {
        if (idx < releases.length) {
          releases[idx++]();
          await Promise.resolve(); // flush microtasks so next waiter can push its release fn
        }
      }
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

    it('resets activeCount to 0 on destroy and held releases do not corrupt counter', async () => {
      const sem = new ChannelSemaphore(2);
      const r1 = await sem.acquire();
      const r2 = await sem.acquire();
      sem.destroy(new Error('done'));
      expect(sem.activeCount).toBe(0);
      // Calling held releases after destroy must not corrupt the counter
      r1();
      r2();
      expect(sem.activeCount).toBe(0); // must not go negative
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

describe('ChannelSemaphore — diagnostic logs', () => {
  describe('always-on (infoLog)', () => {
    it('emits adaptive/reduce when reduceMax actually decreases the cap', () => {
      const cap = setupLogCapture({ enableDiag: false });
      const sem = new ChannelSemaphore(3, 'host:22:user');
      sem.reduceMax();
      const found = cap.find('INFO', 'semaphore', 'adaptive/reduce');
      expect(found).toHaveLength(1);
      expect(found[0].data.label).toBe('host:22:user');
      expect(found[0].data.from).toBe('3');
      expect(found[0].data.to).toBe('2');
    });

    it('does NOT emit adaptive/reduce when already at the floor', () => {
      const cap = setupLogCapture({ enableDiag: false });
      const sem = new ChannelSemaphore(1, 'host');
      cap.reset();
      sem.reduceMax();
      expect(cap.find('INFO', 'semaphore', 'adaptive/reduce')).toHaveLength(0);
    });

    it('emits acquire/timeout with waitedMs and queue position', async () => {
      const cap = setupLogCapture({ enableDiag: false });
      const sem = new ChannelSemaphore(1, 'host');
      const r1 = await sem.acquire();
      cap.reset();
      await expect(sem.acquire(40)).rejects.toBeInstanceOf(ChannelTimeoutError);
      const found = cap.find('INFO', 'semaphore', 'acquire/timeout');
      expect(found).toHaveLength(1);
      expect(found[0].data.label).toBe('host');
      expect(found[0].data.timeoutMs).toBe('40');
      expect(Number(found[0].data.waitedMs)).toBeGreaterThanOrEqual(40);
      r1();
    });

    it('emits destroy with queueRejected count and activeAtDestroy snapshot', async () => {
      const cap = setupLogCapture({ enableDiag: false });
      const sem = new ChannelSemaphore(1, 'host');
      await sem.acquire();
      sem.acquire().catch(() => {/* expected */});
      sem.acquire().catch(() => {/* expected */});
      cap.reset();
      sem.destroy(new Error('Connection closed'));
      const found = cap.find('INFO', 'semaphore', 'destroy');
      expect(found).toHaveLength(1);
      expect(found[0].data.queueRejected).toBe('2');
      expect(found[0].data.activeAtDestroy).toBe('1');
      expect(found[0].data.reason).toBe('Connection closed');
    });
  });

  describe('verbose (diagLog) — only when diagnosticLogging=true', () => {
    it('emits create on construction with label + maxSlots', () => {
      const cap = setupLogCapture({ enableDiag: true });
      new ChannelSemaphore(5, 'host:22:user');
      const found = cap.find('DIAG', 'semaphore', 'create');
      expect(found).toHaveLength(1);
      expect(found[0].data.label).toBe('host:22:user');
      expect(found[0].data.maxSlots).toBe('5');
    });

    it('emits acquire/immediate when a slot is free', async () => {
      const cap = setupLogCapture({ enableDiag: true });
      const sem = new ChannelSemaphore(2, 'h');
      cap.reset();
      const r = await sem.acquire();
      const found = cap.find('DIAG', 'semaphore', 'acquire/immediate');
      expect(found).toHaveLength(1);
      expect(found[0].data.active).toBe('1');
      r();
    });

    it('emits acquire/queued then acquire/woken with waitedMs when slot frees', async () => {
      const cap = setupLogCapture({ enableDiag: true });
      const sem = new ChannelSemaphore(1, 'h');
      const r1 = await sem.acquire();
      cap.reset();
      const p2 = sem.acquire();
      expect(cap.find('DIAG', 'semaphore', 'acquire/queued')).toHaveLength(1);
      r1();
      const r2 = await p2;
      expect(cap.find('DIAG', 'semaphore', 'acquire/woken')).toHaveLength(1);
      const woken = cap.find('DIAG', 'semaphore', 'acquire/woken')[0];
      expect(Number(woken.data.waitedMs)).toBeGreaterThanOrEqual(0);
      r2();
    });

    it('emits release with wokeNext=true when there is a waiter', async () => {
      const cap = setupLogCapture({ enableDiag: true });
      const sem = new ChannelSemaphore(1, 'h');
      const r1 = await sem.acquire();
      sem.acquire(); // queue a waiter
      cap.reset();
      r1();
      const releases = cap.find('DIAG', 'semaphore', 'release');
      expect(releases).toHaveLength(1);
      expect(releases[0].data.wokeNext).toBe('true');
    });

    it('emits release/post-destroy-ignored when held release fires after destroy', async () => {
      const cap = setupLogCapture({ enableDiag: true });
      const sem = new ChannelSemaphore(1, 'h');
      const r1 = await sem.acquire();
      sem.destroy(new Error('done'));
      cap.reset();
      r1();
      expect(cap.find('DIAG', 'semaphore', 'release/post-destroy-ignored')).toHaveLength(1);
    });

    it('emits adaptive/increase when increaseMax actually grows the cap', () => {
      const cap = setupLogCapture({ enableDiag: true });
      const sem = new ChannelSemaphore(4, 'h');
      sem.reduceMax();
      cap.reset();
      sem.increaseMax();
      const found = cap.find('DIAG', 'semaphore', 'adaptive/increase');
      expect(found).toHaveLength(1);
      expect(found[0].data.from).toBe('3');
      expect(found[0].data.to).toBe('4');
    });
  });

  describe('label fallback', () => {
    it('defaults to "unknown" when no label provided', () => {
      const cap = setupLogCapture({ enableDiag: true });
      new ChannelSemaphore(2);
      const found = cap.find('DIAG', 'semaphore', 'create');
      expect(found[0].data.label).toBe('unknown');
    });
  });
});
