import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything a service can run queries on: the database or an open transaction. */
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: "srpska-agora",
    // Fail fast instead of hanging when the database is unreachable.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

// One pool per process. Next.js re-evaluates modules during development, so
// the handle is parked on globalThis to avoid leaking connections on reload.
const globalForDb = globalThis as unknown as { __agoraDb?: DbHandle };

export function getDbHandle(): DbHandle {
  if (!globalForDb.__agoraDb) {
    globalForDb.__agoraDb = createDb(getEnv().DATABASE_URL);
  }
  return globalForDb.__agoraDb;
}

export function getDb(): Db {
  return getDbHandle().db;
}
