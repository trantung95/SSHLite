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
