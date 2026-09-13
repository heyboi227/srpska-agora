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
