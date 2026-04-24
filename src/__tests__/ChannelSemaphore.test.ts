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
