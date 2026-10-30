import { type DateTime, Result } from 'effect';
import { parseEventTime } from './event-times';
import { formatInstant } from './ical-time';

// When a reminder goes off: a number of minutes before (negative) or after
// the start or end of the event, or a fixed instant.
export type ReminderTime =
  | {
      readonly _tag: 'Relative';
      readonly minutes: number;
      readonly related: 'start' | 'end';
    }
  | { readonly _tag: 'Absolute'; readonly ms: number };

export const reminderFormats =
  'a duration before the start, like 15m, 1h30m, 1d, or 2w; a duration followed by "before start", "after start", "before end", or "after end", like 10m after end; or a date-time like 2026-11-10T18:00, read in --time-zone';

// Largest first, so a duration prints in the largest units that fit.
const minutesPerUnit = { w: 10_080, d: 1440, h: 60, m: 1 } as const;

const durationPattern =
  /^(?:(?<w>\d+)w)?(?:(?<d>\d+)d)?(?:(?<h>\d+)h)?(?:(?<m>\d+)m)?$/u;
const relativePattern =
  /^(?<duration>\S+)(?:\s+(?<direction>before|after)\s+(?<edge>start|end))?$/u;
const dateTimeStart = /^\d{4}-\d{2}-\d{2}T/u;

// The minutes of a duration like 1h30m, or none when it is not one.
const durationMinutes = (text: string): number | undefined => {
  const groups = durationPattern.exec(text)?.groups ?? {};
  const counts = Object.entries(minutesPerUnit).flatMap(([unit, size]) => {
    const count = groups[unit];
    return count === undefined ? [] : [Number(count) * size];
  });
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.length > 0 && Number.isSafeInteger(total) ? total : undefined;
};

// Like 1w, 1d2h, or 1h30m; 0m for none.
export const formatDuration = (minutes: number): string => {
  const parts: Array<string> = [];
  let rest = minutes;
  for (const [unit, size] of Object.entries(minutesPerUnit)) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      rest -= count * size;
    }
  }
  return parts.length === 0 ? '0m' : parts.join('');
};

// Like 1h30m before start, the form --reminder takes back.
export const relativeWhen = (
  minutes: number,
  related: 'start' | 'end',
): string =>
  `${formatDuration(Math.abs(minutes))} ${minutes > 0 ? 'after' : 'before'} ${related}`;

// A reminder as "pim calendar get" prints it: relative ones as above,
// absolute ones as a date-time with offset in `zone`.
export const reminderWhen = (
  time: ReminderTime,
  zone: DateTime.TimeZone,
): string =>
  time._tag === 'Absolute'
    ? formatInstant(time.ms, zone)
    : relativeWhen(time.minutes, time.related);

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
  const minutes = durationMinutes(relative?.duration ?? '');
  if (relative !== undefined && minutes !== undefined) {
    return Result.succeed({
      _tag: 'Relative',
      // 0m before start is 0, not -0, which compares unequal in tests.
      minutes:
        relative.direction === 'after' || minutes === 0 ? minutes : -minutes,
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
