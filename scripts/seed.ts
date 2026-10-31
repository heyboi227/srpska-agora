import { createDb } from "@/lib/db/client";
import { getEnv, loadDotEnv } from "@/lib/env";
import { seedDemo } from "@/lib/seed/demo";

/**
 * Seeds the demo into the development database. The body lives in
 * `src/lib/seed/demo.ts` so the simulation can reuse it. Idempotent.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  const handle = createDb(env.DATABASE_URL, { max: 4 });
  try {
    const summary = await seedDemo(handle.db);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.skipped.length > 0) process.exitCode = 2;
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
