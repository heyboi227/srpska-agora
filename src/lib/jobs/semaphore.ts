/**
 * A tiny in-process counting semaphore. The worker wraps every content job in
 * one shared instance so the process never holds more paid jobs than
 * `runtime.maxConcurrentPaidCalls`, whatever the per-queue concurrency is.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be >= 1");
  }

  /** Changes the slot count; waiting callers start as soon as room appears. */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be >= 1");
    this.limit = limit;
    this.drain();
  }

  get inUse(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.waiting.shift();
      if (!next) return;
      this.active += 1;
      next();
    }
  }
}
