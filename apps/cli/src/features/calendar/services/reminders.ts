import { type DateTime, Result } from 'effect';
import { parseEventTime } from './event-times';
import { formatInstant } from './ical-time';

// When a reminder goes off: a number of days and seconds before (negative)
// or after the start or end of the event, or a fixed instant. Days are
// nominal and seconds exact (RFC 5545, section 3.3.6), so 1d and 24h differ
// across a daylight saving change. Both have the same sign.
export type ReminderTime =
  | {
      readonly _tag: 'Relative';
      readonly days: number;
      readonly seconds: number;
      readonly related: 'start' | 'end';
    }
  | { readonly _tag: 'Absolute'; readonly ms: number };

export const reminderFormats =
  'a duration before the start, like 15m, 1h30m, 1d, or 2w; a duration followed by "before start", "after start", "before end", or "after end", like 10m after end; or a date-time like 2026-11-10T18:00, read in --time-zone';

export const secondsPerMinute = 60;

// Largest first, so a duration prints in the largest units that fit. Weeks
// and days count days, hours and minutes count minutes.
const daysPerUnit = { w: 7, d: 1 } as const;
const minutesPerUnit = { h: 60, m: 1 } as const;

const durationPattern =
  /^(?:(?<w>\d+)w)?(?:(?<d>\d+)d)?(?:(?<h>\d+)h)?(?:(?<m>\d+)m)?$/u;
const relativePattern =
  /^(?<duration>\S+)(?:\s+(?<direction>before|after)\s+(?<edge>start|end))?$/u;
const dateTimeStart = /^\d{4}-\d{2}-\d{2}T/u;

// The days and minutes of a duration like 1d2h, or none when it is not one.
const durationOf = (
  text: string,
): { readonly days: number; readonly minutes: number } | undefined => {
  const groups = durationPattern.exec(text)?.groups;
  if (
    groups === undefined ||
    Object.values(groups).every((count) => count === undefined)
  ) {
    return;
  }
  const total = (perUnit: Readonly<Record<string, number>>): number =>
    Object.entries(perUnit).reduce(
      (sum, [unit, size]) => sum + Number(groups[unit] ?? 0) * size,
      0,
    );
  const days = total(daysPerUnit);
  const minutes = total(minutesPerUnit);
  return Number.isSafeInteger(days) &&
    Number.isSafeInteger(minutes * secondsPerMinute)
    ? { days, minutes }
    : undefined;
};

const unitsOf = (
  amount: number,
  perUnit: Readonly<Record<string, number>>,
): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let rest = amount;
  for (const [unit, size] of Object.entries(perUnit)) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      rest -= count * size;
    }
  }
  return parts;
};

// Like 1w, 1d2h, 24h, or 1h30m; 0m for none.
export const formatDuration = (days: number, minutes: number): string => {
  const parts = [
    ...unitsOf(days, daysPerUnit),
    ...unitsOf(minutes, minutesPerUnit),
  ];
  return parts.length === 0 ? '0m' : parts.join('');
};

// Like 1h30m before start, the form --reminder takes back. Seconds round
// down to the minute, so the reminder, written back with --reminder, never
// goes off later.
export const relativeWhen = (
  days: number,
  seconds: number,
  related: 'start' | 'end',
): string => {
  const minutes = Math.floor(seconds / secondsPerMinute);
  const after = days > 0 || minutes > 0;
  return `${formatDuration(Math.abs(days), Math.abs(minutes))} ${after ? 'after' : 'before'} ${related}`;
};

// A reminder as "pim calendar get" prints it: relative ones as above,
// absolute ones as a date-time with offset in `zone`.
export const reminderWhen = (
  time: ReminderTime,
  zone: DateTime.TimeZone,
): string =>
  time._tag === 'Absolute'
    ? formatInstant(time.ms, zone)
    : relativeWhen(time.days, time.seconds, time.related);

const unknownForm = Result.fail(`must be ${reminderFormats}`);

// Reads 15m or 1h30m as before the start, 10m after end and the like as
// relative to that end of the event, and a date-time as for --start. Fails
// with the reason, to follow the option name.
export const parseReminder = (
  value: string,
  zone: DateTime.TimeZone,
): Result.Result<ReminderTime, string> => {
  const text = value.trim();
  const relative = relativePattern.exec(text)?.groups;
  const duration = durationOf(relative?.duration ?? '');
  if (relative !== undefined && duration !== undefined) {
    const sign = relative.direction === 'after' ? 1 : -1;
    return Result.succeed({
      _tag: 'Relative',
      // Adding 0 turns -0, which compares unequal in tests, into 0.
      days: sign * duration.days + 0,
      seconds: sign * duration.minutes * secondsPerMinute + 0,
      related: relative.edge === 'end' ? 'end' : 'start',
    });
  }
  if (!dateTimeStart.test(text)) {
    return unknownForm;
  }
  return Result.flatMap(parseEventTime(text, zone), (time) =>
    time._tag === 'Instant'
      ? Result.succeed({ _tag: 'Absolute', ms: time.ms })
      : unknownForm,
  );
};
