import { defineConfig } from "drizzle-kit";

// drizzle-kit reads .env itself only in some commands, so load it explicitly.
// Node 24 ships process.loadEnvFile; the guard keeps CI without a .env working.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the process environment.
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set; copy .env.example to .env first.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
