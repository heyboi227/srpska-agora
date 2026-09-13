import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { invalidateConfigCache } from "@/lib/config/service";
import { testDb, testHandle, truncateAll } from "./helpers";

beforeAll(async () => {
  await migrate(testDb(), { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  await truncateAll(testDb());
  invalidateConfigCache();
});

afterAll(async () => {
  await testHandle().close();
  (globalThis as { __agoraTestDb?: unknown }).__agoraTestDb = undefined;
});
