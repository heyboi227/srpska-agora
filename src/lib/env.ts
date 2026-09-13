import { z } from "zod";

/**
 * Process environment, validated once. Next.js loads .env for the web app;
 * scripts and the worker call loadDotEnv() first. Nothing here is exposed to
 * the browser: only server code imports this module.
 */

let loaded = false;

export function loadDotEnv(path = ".env"): void {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env present: the process environment is authoritative (containers, CI).
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_TEST: z.string().min(1).optional(),
  AGORA_RUNTIME_MODE: z.enum(["mock", "live"]).default("mock"),
  AGORA_CONFIG_PRESET: z.enum(["quiet", "standard"]).default("standard"),
  AGORA_ADMIN_USERNAME: z.string().min(3).max(64).optional(),
  AGORA_ADMIN_PASSWORD: z.string().min(1).optional(),
  AGORA_PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = process.env[key];
    // Empty strings in .env mean "unset"; keep placeholders from failing validation.
    raw[key] = value === "" ? undefined : value;
  }
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached environment so a test can override it. */
export function resetEnvCache(): void {
  cached = undefined;
}
