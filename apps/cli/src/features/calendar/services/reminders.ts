import { type DateTime, Result } from 'effect';
import { parseEventTime } from './event-times';
import { formatInstant } from './ical-time';

// The times a reminder goes off again: count more times, each a number of
// days and seconds after the one before (RFC 5545, section 3.8.6.2).
// --reminder takes only repeats that move forward.
export type ReminderRepeat = {
  readonly count: number;
  readonly days: number;
  readonly seconds: number;
};

// When a reminder goes off: a number of days and seconds before (negative)
// or after the start or end of the event, or a fixed instant, and then any
// repeats. Days are nominal and seconds exact (RFC 5545, section 3.3.6), so
// 1d and 24h differ across a daylight saving change. Both have the same sign.
export type ReminderTime = (
  | {
      readonly _tag: 'Relative';
      readonly days: number;
      readonly seconds: number;
      readonly related: 'start' | 'end';
    }
  | { readonly _tag: 'Absolute'; readonly ms: number }
) & { readonly repeat?: ReminderRepeat };

export const reminderFormats =
  'a duration before the start, like 15m, 1h30m, 1d, or 2w; a duration followed by "before start", "after start", "before end", or "after end", like 10m after end; or a date-time like 2026-11-10T18:00, read in --time-zone; any of these may end in "repeat <n> every <duration>" to go off n more times, like 15m repeat 2 every 5m';

export const secondsPerMinute = 60;

// The largest INTEGER, which REPEAT holds (RFC 5545, section 3.3.8).
const maxRepeat = 2_147_483_647;

// Largest first, so a duration prints in the largest units that fit. Weeks
// and days count days, hours and minutes count minutes.
const daysPerUnit = { w: 7, d: 1 } as const;
const minutesPerUnit = { h: 60, m: 1 } as const;

const durationPattern =
  /^(?:(?<w>\d+)w)?(?:(?<d>\d+)d)?(?:(?<h>\d+)h)?(?:(?<m>\d+)m)?$/u;
const relativePattern =
  /^(?<duration>\S+)(?:\s+(?<direction>before|after)\s+(?<edge>start|end))?$/u;
const dateTimeStart = /^\d{4}-\d{2}-\d{2}T/u;
const repeatWord = /\s+repeat\s+/u;
const repeatPattern = /^(?<count>\d+)\s+every\s+(?<delay>\S+)$/u;

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

// Like " repeat 2 every 5m", or nothing without repeats. Seconds round down
// to the minute, as in relativeWhen, so no repeat goes off later; repeats
// less than a minute apart then print as none.
const repeatWhen = (repeat: ReminderRepeat | undefined): string => {
  if (repeat === undefined) {
    return '';
  }
  const minutes = Math.floor(repeat.seconds / secondsPerMinute);
  return repeat.days > 0 || minutes > 0
    ? ` repeat ${repeat.count} every ${formatDuration(repeat.days, minutes)}`
    : '';
};

// A reminder as "pim calendar get" prints it: relative ones as above,
// absolute ones as a date-time with offset in `zone`, either followed by its
// repeats.
export const reminderWhen = (
  time: ReminderTime,
  zone: DateTime.TimeZone,
): string =>
  (time._tag === 'Absolute'
    ? formatInstant(time.ms, zone)
    : relativeWhen(time.days, time.seconds, time.related)) +
  repeatWhen(time.repeat);

const unknownForm = Result.fail(`must be ${reminderFormats}`);

// The repeats in text like 2 every 5m, or none when it is not that.
const repeatOf = (text: string): ReminderRepeat | undefined => {
  const groups = repeatPattern.exec(text)?.groups;
  const count = Number(groups?.count);
  const delay = durationOf(groups?.delay ?? '');
  return count >= 1 &&
    count <= maxRepeat &&
    delay !== undefined &&
    delay.days + delay.minutes > 0
    ? { count, days: delay.days, seconds: delay.minutes * secondsPerMinute }
    : undefined;
};

// The first time of a reminder, without its repeats.
const firstTimeOf = (
  text: string,
  zone: DateTime.TimeZone,
): Result.Result<ReminderTime, string> => {
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

// Reads 15m or 1h30m as before the start, 10m after end and the like as
// relative to that end of the event, and a date-time as for --start, each
// with any repeats after "repeat". Fails with the reason, to follow the
// option name.
export const parseReminder = (
  value: string,
  zone: DateTime.TimeZone,
): Result.Result<ReminderTime, string> => {
  const [base = '', suffix, ...rest] = value.trim().split(repeatWord);
  if (suffix === undefined) {
    return firstTimeOf(base, zone);
  }
  const repeat = rest.length === 0 ? repeatOf(suffix) : undefined;
  return repeat === undefined
    ? unknownForm
    : Result.map(firstTimeOf(base, zone), (time) => ({ ...time, repeat }));
};
