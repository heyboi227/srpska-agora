import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@/lib/db/client";
import { getEnv, loadDotEnv } from "@/lib/env";

/**
 * Applies pending migrations from ./drizzle. Safe to run repeatedly; the
 * migrator records applied files in drizzle.__drizzle_migrations.
 *
 * Usage: npm run db:migrate            (DATABASE_URL)
 *        npm run db:migrate -- --test  (DATABASE_URL_TEST)
 */
async function main(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  const useTest = process.argv.includes("--test");
  const url = useTest ? env.DATABASE_URL_TEST : env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL_TEST is not set.");
  }
  const handle = createDb(url, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    console.log(`Migrations applied to ${useTest ? "test" : "main"} database.`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
