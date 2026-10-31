/**
 * Time helpers. Storage is UTC everywhere; Europe/Belgrade applies only when a
 * date is shown to a reader or when the editorial schedule asks what local hour
 * it is.
 */

export const EDITORIAL_TIMEZONE = "Europe/Belgrade";
const LOCALE = "sr-Latn-RS";

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: EDITORIAL_TIMEZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: EDITORIAL_TIMEZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
});

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: EDITORIAL_TIMEZONE,
  hour: "numeric",
  hourCycle: "h23",
});

const relativeFormatter = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

/** "12. septembar 2026. 14:05" in Belgrade local time. */
export function formatBelgradeDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

export function formatBelgradeDate(date: Date): string {
  return dateFormatter.format(date);
}

/** Local hour 0..23 in Belgrade for the given instant. */
export function belgradeHour(date: Date): number {
  return Number.parseInt(hourFormatter.format(date), 10);
}

/** "pre 5 minuta", "pre 3 sata", "juče", "pre 2 dana", falling back to a date after a week. */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return "upravo sada";
  if (abs < 3600) return relativeFormatter.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 86_400) return relativeFormatter.format(Math.round(diffSeconds / 3600), "hour");
  if (abs < 7 * 86_400)
    return relativeFormatter.format(Math.round(diffSeconds / 86_400), "day");
  return formatBelgradeDate(date);
}

export function isoOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: EDITORIAL_TIMEZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface BelgradeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** Calendar fields of an instant in Europe/Belgrade. */
export function belgradeParts(date: Date): BelgradeParts {
  const map: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(date)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: WEEKDAYS.indexOf(map.weekday ?? ""),
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "YYYY-MM-DD" of the Belgrade calendar day containing the instant. */
export function belgradeDayKey(date: Date): string {
  const { year, month, day } = belgradeParts(date);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** The UTC instant at which the given Belgrade wall-clock day starts (00:00 local). */
function belgradeMidnight(year: number, month: number, day: number): Date {
  // Midnight local is between 21:00 and 23:00 UTC of the previous day; probe hourly.
  const base = Date.UTC(year, month - 1, day, 0, 0, 0) - 3 * 3_600_000;
  for (let step = 0; step <= 6; step++) {
    const candidate = new Date(base + step * 3_600_000);
    const p = belgradeParts(candidate);
    if (p.year === year && p.month === month && p.day === day && p.hour === 0) {
      return new Date(candidate.getTime() - p.minute * 60_000);
    }
  }
  throw new Error(`No Belgrade midnight found for ${year}-${month}-${day}`);
}

/** 00:00 Belgrade time on the Belgrade day containing `date`. */
export function belgradeDayStart(date: Date): Date {
  const { year, month, day } = belgradeParts(date);
  return belgradeMidnight(year, month, day);
}

/** 00:00 Belgrade time of the following Belgrade day (handles 23/25-hour days). */
export function belgradeNextDayStart(date: Date): Date {
  const { year, month, day } = belgradeParts(date);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return belgradeMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function utcNextDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

export function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function utcNextMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

/** True when `hour` is in [startHour, endHour), wrapping past midnight; start === end is never night. */
export function isNightHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}
