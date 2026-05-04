// src/services/ChannelSemaphore.ts

import { diagLog, infoLog } from '../utils/diagnosticLog';

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
  enqueuedAt: number;
}

export class ChannelSemaphore {
  private _maxSlots: number;
  private readonly _initialMax: number;
  private _activeCount = 0;
  private _waitQueue: Waiter[] = [];
  private _consecutiveSuccesses = 0;
  private _destroyed = false;
  private readonly _label: string;

  constructor(maxSlots: number, label?: string) {
    this._maxSlots = maxSlots;
    this._initialMax = maxSlots;
    this._label = label ?? 'unknown';
    diagLog('semaphore', 'create', { label: this._label, maxSlots });
  }

  get maxSlots(): number { return this._maxSlots; }
  get activeCount(): number { return this._activeCount; }
  get queued(): number { return this._waitQueue.length; }
  get available(): number { return Math.max(0, this._maxSlots - this._activeCount); }

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this._activeCount < this._maxSlots) {
      this._activeCount++;
      diagLog('semaphore', 'acquire/immediate', {
        label: this._label,
        active: this._activeCount,
        max: this._maxSlots,
      });
      return this._makeRelease();
    }
    diagLog('semaphore', 'acquire/queued', {
      label: this._label,
      active: this._activeCount,
      max: this._maxSlots,
      queueDepthBefore: this._waitQueue.length,
      timeoutMs: timeoutMs ?? 'none',
    });
    return new Promise<() => void>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const waiter: Waiter = {
        enqueuedAt,
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this._activeCount++;
          diagLog('semaphore', 'acquire/woken', {
            label: this._label,
            waitedMs: Date.now() - enqueuedAt,
            active: this._activeCount,
            max: this._maxSlots,
            queueDepthAfter: this._waitQueue.length,
          });
          resolve(this._makeRelease());
        },
        reject,
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const idx = this._waitQueue.indexOf(waiter);
          if (idx !== -1) this._waitQueue.splice(idx, 1);
          infoLog('semaphore', 'acquire/timeout', {
            label: this._label,
            timeoutMs,
            waitedMs: Date.now() - enqueuedAt,
            active: this._activeCount,
            max: this._maxSlots,
            queueDepthAfter: this._waitQueue.length,
          });
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
    const before = this._maxSlots;
    this._maxSlots = Math.max(1, this._maxSlots - 1);
    this._consecutiveSuccesses = 0;
    if (before !== this._maxSlots) {
      infoLog('semaphore', 'adaptive/reduce', {
        label: this._label,
        from: before,
        to: this._maxSlots,
        floor: 1,
      });
    }
  }

  increaseMax(): void {
    const before = this._maxSlots;
    this._maxSlots = Math.min(this._initialMax, this._maxSlots + 1);
    this._consecutiveSuccesses = 0;
    if (before !== this._maxSlots) {
      diagLog('semaphore', 'adaptive/increase', {
        label: this._label,
        from: before,
        to: this._maxSlots,
        ceiling: this._initialMax,
      });
    }
  }

  destroy(err: Error): void {
    const queueRejected = this._waitQueue.length;
    this._destroyed = true;
    for (const waiter of this._waitQueue) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this._waitQueue = [];
    const activeBefore = this._activeCount;
    this._activeCount = 0;
    infoLog('semaphore', 'destroy', {
      label: this._label,
      reason: err.message,
      queueRejected,
      activeAtDestroy: activeBefore,
    });
  }

  private _makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this._destroyed) {
        diagLog('semaphore', 'release/post-destroy-ignored', { label: this._label });
        return;
      }
      this._activeCount--;
      const woke = this._waitQueue.length > 0;
      diagLog('semaphore', 'release', {
        label: this._label,
        active: this._activeCount,
        max: this._maxSlots,
        queueDepth: this._waitQueue.length,
        wokeNext: woke,
      });
      if (woke) {
        this._waitQueue.shift()!.resolve();
      }
    };
  }
}
