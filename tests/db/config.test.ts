import { describe, expect, it } from "vitest";
import { QUIET_PRESET, STANDARD_PRESET } from "@/lib/config/presets";
import {
  getActiveConfig,
  getActiveConfigRevision,
  listConfigRevisions,
  rollbackConfigTo,
  saveConfigRevision,
} from "@/lib/config/service";
import { testDb } from "./helpers";

describe("configuration revisions", () => {
  it("falls back to the environment preset before any revision exists", async () => {
    const config = await getActiveConfig(testDb());
    expect(config.preset).toBe("standard");
    expect(await getActiveConfigRevision(testDb())).toBeNull();
  });

  it("keeps exactly one active revision and supports rollback as a new revision", async () => {
    const db = testDb();
    const first = await saveConfigRevision(db, {
      config: STANDARD_PRESET,
      changeKind: "seed",
      changedByAccountId: null,
      reason: "Početna konfiguracija.",
    });
    expect(first.revision).toBe(1);

    const paused = structuredClone(QUIET_PRESET);
    paused.runtime.pauseAllActions = true;
    const second = await saveConfigRevision(db, {
      config: paused,
      changeKind: "admin",
      changedByAccountId: null,
      reason: "Pauza.",
    });
    expect(second.revision).toBe(2);

    const active = await getActiveConfig(db);
    expect(active.preset).toBe("quiet");
    expect(active.runtime.pauseAllActions).toBe(true);

    const third = await rollbackConfigTo(db, 1, { changedByAccountId: null, reason: "" });
    expect(third.revision).toBe(3);
    const restored = await getActiveConfig(db);
    expect(restored.preset).toBe("standard");
    expect(restored.runtime.pauseAllActions).toBe(false);

    const list = await listConfigRevisions(db);
    expect(list.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(list.filter((r) => r.isActive)).toHaveLength(1);
  });

  it("rejects an invalid configuration before touching the table", async () => {
    const db = testDb();
    const broken = structuredClone(STANDARD_PRESET);
    broken.content.maxNewThreadsPerDay = 999;
    await expect(
      saveConfigRevision(db, {
        config: broken,
        changeKind: "admin",
        changedByAccountId: null,
        reason: "x",
      }),
    ).rejects.toThrow();
    expect(await listConfigRevisions(db)).toEqual([]);
  });
});
