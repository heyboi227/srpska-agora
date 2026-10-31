import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";

/** Time source, injectable so schedulers and tests can control "now". */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests and simulations move by hand. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Follows database time via a cached offset, so workers agree with the database. */
export class DbTimeClock implements Clock {
  private offsetMs = 0;
  private syncedAt = 0;

  constructor(
    private readonly db: DbOrTx,
    private readonly refreshMs = 60_000,
  ) {}

  async sync(): Promise<void> {
    const before = Date.now();
    const rows = await this.db.execute<{ ms: number | string }>(
      sql`select (extract(epoch from now()) * 1000)::float8 as ms`,
    );
    const raw = rows.rows[0]?.ms;
    if (raw === undefined) throw new Error("select now() returned no row");
    this.offsetMs = Number(raw) - before;
    this.syncedAt = Date.now();
  }

  async syncIfStale(): Promise<void> {
    if (Date.now() - this.syncedAt >= this.refreshMs) await this.sync();
  }

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}
