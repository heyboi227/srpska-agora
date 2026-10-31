import { describe, expect, it } from "vitest";
import { ManualClock } from "@/lib/clock";
import {
  belgradeDayKey,
  belgradeDayStart,
  belgradeNextDayStart,
  belgradeParts,
  isNightHour,
  utcDayStart,
  utcMonthStart,
  utcNextDayStart,
  utcNextMonthStart,
} from "@/lib/time";

const iso = (d: Date) => d.toISOString();
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

describe("Belgrade time helpers", () => {
  it("computes parts and day keys across midnight", () => {
    expect(belgradeDayKey(new Date("2026-11-01T23:30:00Z"))).toBe("2026-11-02");
    expect(belgradeDayKey(new Date("2026-11-01T22:30:00Z"))).toBe("2026-11-01");
    expect(belgradeParts(new Date("2026-11-01T23:30:00Z"))).toEqual({
      year: 2026,
      month: 11,
      day: 2,
      hour: 0,
      minute: 30,
      weekday: 1,
    });
  });

  it("handles an ordinary day", () => {
    const d = new Date("2026-06-15T10:00:00Z");
    expect(iso(belgradeDayStart(d))).toBe("2026-06-14T22:00:00.000Z");
    expect(iso(belgradeNextDayStart(d))).toBe("2026-06-15T22:00:00.000Z");
  });

  it("handles the 23-hour spring-forward day (2026-03-29)", () => {
    const d = new Date("2026-03-29T12:00:00Z");
    const start = belgradeDayStart(d);
    const next = belgradeNextDayStart(d);
    expect(iso(start)).toBe("2026-03-28T23:00:00.000Z");
    expect(iso(next)).toBe("2026-03-29T22:00:00.000Z");
    expect(hours(start, next)).toBe(23);
  });

  it("handles the 25-hour fall-back day (2026-10-25)", () => {
    const d = new Date("2026-10-25T12:00:00Z");
    const start = belgradeDayStart(d);
    const next = belgradeNextDayStart(d);
    expect(iso(start)).toBe("2026-10-24T22:00:00.000Z");
    expect(iso(next)).toBe("2026-10-25T23:00:00.000Z");
    expect(hours(start, next)).toBe(25);
  });
});

describe("UTC period helpers", () => {
  it("returns day and month boundaries", () => {
    const d = new Date("2026-12-31T18:45:00Z");
    expect(iso(utcDayStart(d))).toBe("2026-12-31T00:00:00.000Z");
    expect(iso(utcNextDayStart(d))).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(utcMonthStart(d))).toBe("2026-12-01T00:00:00.000Z");
    expect(iso(utcNextMonthStart(d))).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("isNightHour", () => {
  it("wraps past midnight", () => {
    for (const h of [23, 0, 3, 6]) expect(isNightHour(h, 23, 7)).toBe(true);
    for (const h of [7, 12, 22]) expect(isNightHour(h, 23, 7)).toBe(false);
  });

  it("works without wrap-around and never when start equals end", () => {
    expect(isNightHour(1, 1, 5)).toBe(true);
    expect(isNightHour(5, 1, 5)).toBe(false);
    expect(isNightHour(0, 1, 5)).toBe(false);
    expect(isNightHour(3, 4, 4)).toBe(false);
  });
});

describe("ManualClock", () => {
  it("advances and sets", () => {
    const clock = new ManualClock(new Date("2026-01-01T00:00:00Z"));
    clock.advance(90_000);
    expect(iso(clock.now())).toBe("2026-01-01T00:01:30.000Z");
    clock.set(new Date("2026-02-01T00:00:00Z"));
    expect(iso(clock.now())).toBe("2026-02-01T00:00:00.000Z");
  });
});
