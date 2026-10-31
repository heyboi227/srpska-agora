import { belgradeParts } from "@/lib/time";

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step in "${field}"`);
    let from = min;
    let to = max;
    if (range !== "*") {
      const [a = "", b] = range.split("-");
      from = Number(a);
      to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new Error(`Bad cron field "${field}"`);
      }
    }
    return value >= from && value <= to && (value - from) % step === 0;
  });
}

/**
 * Whether a five-field cron expression matches the minute containing `date`,
 * read in Europe/Belgrade. Supports `*`, numbers, lists, ranges and steps in
 * the minute and hour fields; day, month and weekday must be `*`.
 */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron needs five fields: "${expression}"`);
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
  if (dom !== "*" || month !== "*" || dow !== "*") {
    throw new Error(`Only minute and hour fields are supported: "${expression}"`);
  }
  const parts = belgradeParts(date);
  return fieldMatches(minute, parts.minute, 0, 59) && fieldMatches(hour, parts.hour, 0, 23);
}

/** Whole minutes in (from, to], used to find cron times crossed between two ticks. */
export function minutesBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const first = Math.floor(from.getTime() / 60_000) + 1;
  const last = Math.floor(to.getTime() / 60_000);
  for (let m = first; m <= last; m += 1) out.push(new Date(m * 60_000));
  return out;
}
