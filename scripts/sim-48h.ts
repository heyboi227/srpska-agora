import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { loadDotEnv } from "@/lib/env";
import {
  buildReport,
  consoleSummary,
  defaultScenario,
  markdownSummary,
  runSimulation,
} from "@/lib/simulation";

/**
 * The simulated 48-hour run: the real scheduler, job handler, cost gateway,
 * domain services and cleanup against the TEST database, on a manual clock.
 * It empties that database first, so it refuses any name without "_test".
 *
 * Usage: npm run sim:48h
 */
async function main(): Promise<void> {
  loadDotEnv();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST must point at a test database.");
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.includes("_test")) {
    throw new Error(`Refusing to run on database "${name}": its name must contain "_test".`);
  }

  const scenario = defaultScenario();
  const handle = createDb(url, { max: 4 });
  try {
    let lastHour = -1;
    const record = await runSimulation(handle.db, scenario, {
      onProgress: ({ at }) => {
        const hour = Math.round((at.getTime() - scenario.start.getTime()) / 3_600_000);
        if (hour !== lastHour && hour % 6 === 0) {
          lastHour = hour;
          process.stderr.write(`  simulated hour ${hour} of ${scenario.hours}\n`);
        }
      },
    });
    const report = await buildReport(handle.db, scenario, record);
    console.log(consoleSummary(report));

    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
    const dir = path.resolve("sim-reports");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `sim-${stamp}.json`), JSON.stringify(report, null, 2));
    await writeFile(path.join(dir, `sim-${stamp}.md`), markdownSummary(report));
    console.log(`Reports written to sim-reports/sim-${stamp}.json and .md`);
    if (report.violations.length > 0) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
