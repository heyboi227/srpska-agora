import { upsertAdminAccount } from "@/lib/auth/login";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { createDb } from "@/lib/db/client";
import { getEnv, loadDotEnv } from "@/lib/env";

/**
 * Creates or resets the administrator account from AGORA_ADMIN_USERNAME and
 * AGORA_ADMIN_PASSWORD. The password is read from the environment only, so it
 * never appears in a shell history or a process list. There is no default.
 *
 * Usage: npm run admin:create
 */
async function main(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  const username = env.AGORA_ADMIN_USERNAME;
  const password = env.AGORA_ADMIN_PASSWORD;
  if (!username || !password) {
    console.error(
      "Set AGORA_ADMIN_USERNAME and AGORA_ADMIN_PASSWORD in .env (or the environment) and run again.",
    );
    process.exitCode = 1;
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`AGORA_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exitCode = 1;
    return;
  }
  const handle = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const result = await upsertAdminAccount(handle.db, { username, password });
    console.log(
      `Administrator "${username}" ${result.created ? "created" : "updated"}. Sign in at ${env.AGORA_PUBLIC_BASE_URL}/admin/login`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
