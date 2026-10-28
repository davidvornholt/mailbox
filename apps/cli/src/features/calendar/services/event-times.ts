import { DateTime, Option, Result } from 'effect';
import {
  addDays,
  type CalendarDate,
  daysBetween,
  parseCalendarDate,
} from './calendar-dates';

// A time given for a new or changed event: a date for an all-day event, or
// an instant for a timed one.
export type EventTime =
  | { readonly _tag: 'Date'; readonly date: CalendarDate }
  | { readonly _tag: 'Instant'; readonly ms: number };

// When an event takes place. An all-day event runs from its first to its
// last day, both included.
export type EventSpan =
  | {
      readonly _tag: 'Days';
      readonly first: CalendarDate;
      readonly last: CalendarDate;
    }
  | {
      readonly _tag: 'Times';
      readonly startMs: number;
      readonly endMs: number;
    };

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const dateTimePattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?<offset>Z|[+-]\d{2}:\d{2})?$/u;
const offsetPattern = /^(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2})$/u;
const minutesPerHour = 60;
const millisPerMinute = 60_000;
const maxOffsetHours = 14;

type Parts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

// Date.UTC rolls 2026-02-30 over to March, so a real date reads back the
// same parts.
const utcMillis = (parts: Parts): number | undefined => {
  const ms = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const date = new Date(ms);
  return date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day &&
    date.getUTCHours() === parts.hour &&
    date.getUTCMinutes() === parts.minute &&
    date.getUTCSeconds() === parts.second
    ? ms
    : undefined;
};

const offsetMillis = (offset: string): number | undefined => {
  if (offset === 'Z') {
    return 0;
  }
  const { sign, hours, minutes } = offsetPattern.exec(offset)?.groups ?? {};
  const hourCount = Number(hours);
  const minuteCount = Number(minutes);
  if (!(hourCount <= maxOffsetHours && minuteCount < minutesPerHour)) {
    return;
  }
  return (
    (sign === '-' ? -1 : 1) *
    (hourCount * minutesPerHour + minuteCount) *
    millisPerMinute
  );
};

// A wall-clock time that a DST change skips or repeats has no single
// instant, so it is refused rather than guessed.
const wallClockMillis = (
  parts: Parts,
  zone: DateTime.TimeZone,
): Result.Result<number, string> =>
  Option.match(
    DateTime.makeZoned(parts, {
      timeZone: zone,
      adjustForTimeZone: true,
      disambiguation: 'reject',
    }),
    {
      onNone: () =>
        Result.fail(
          `does not exist or occurs twice in ${DateTime.zoneToString(zone)} because of a daylight saving change; add the UTC offset, like +01:00`,
        ),
      onSome: (zoned) => Result.succeed(DateTime.toEpochMillis(zoned)),
    },
  );

const dateTimeOf = (
  groups: Readonly<Record<string, string | undefined>>,
  zone: DateTime.TimeZone,
): Result.Result<EventTime, string> => {
  const { year, month, day, hour, minute, second, offset } = groups;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? '0'),
  };
  const asUtc = utcMillis(parts);
  if (asUtc === undefined) {
    return Result.fail('is not a real date and time');
  }
  if (offset === undefined) {
    return Result.map(wallClockMillis(parts, zone), (ms) => ({
      _tag: 'Instant',
      ms,
    }));
  }
  const shift = offsetMillis(offset);
  return shift === undefined
    ? Result.fail(`has an invalid UTC offset ${offset}`)
    : Result.succeed({ _tag: 'Instant', ms: asUtc - shift });
};

// Reads 2026-10-28 as a date, 2026-10-28T14:30 or 2026-10-28T14:30:00 as a
// wall-clock time in `zone`, and 2026-10-28T14:30:00+01:00 or ...Z as an
// instant. Fails with the reason, to follow the option name.
export const parseEventTime = (
  value: string,
  zone: DateTime.TimeZone,
): Result.Result<EventTime, string> => {
  if (datePattern.test(value)) {
    const date = parseCalendarDate(value);
    return date === undefined
      ? Result.fail('is not a real date')
      : Result.succeed({ _tag: 'Date', date });
  }
  const groups = dateTimePattern.exec(value)?.groups;
  return groups === undefined
    ? Result.fail(
        'must be a date like 2026-10-28 or a date-time like 2026-10-28T14:30',
      )
    : dateTimeOf(groups, zone);
};

const mixedKinds =
  '--start and --end must both be dates, for an all-day event, or both date-times';

// The span from a start and an optional end. An all-day event without an end
// lasts its start day; a timed one needs an end.
export const spanBetween = (
  start: EventTime,
  end: EventTime | undefined,
): Result.Result<EventSpan, string> => {
  if (start._tag === 'Date') {
    if (end === undefined) {
      return Result.succeed({
        _tag: 'Days',
        first: start.date,
        last: start.date,
      });
    }
    if (end._tag !== 'Date') {
      return Result.fail(mixedKinds);
    }
    return daysBetween(start.date, end.date) < 0
      ? Result.fail('--end is before --start')
      : Result.succeed({ _tag: 'Days', first: start.date, last: end.date });
  }
  if (end === undefined) {
    return Result.fail('a timed event needs --end');
  }
  if (end._tag !== 'Instant') {
    return Result.fail(mixedKinds);
  }
  return end.ms > start.ms
    ? Result.succeed({ _tag: 'Times', startMs: start.ms, endMs: end.ms })
    : Result.fail('--end must be after --start');
};

// The span after changing the start, the end, or both. A new start alone
// moves the event and keeps its length.
export const changedSpan = (
  current: EventSpan,
  start: EventTime | undefined,
  end: EventTime | undefined,
): Result.Result<EventSpan, string> => {
  if (start === undefined) {
    return end === undefined
      ? Result.succeed(current)
      : spanBetween(
          current._tag === 'Days'
            ? { _tag: 'Date', date: current.first }
            : { _tag: 'Instant', ms: current.startMs },
          end,
        );
  }
  if (end !== undefined) {
    return spanBetween(start, end);
  }
  if (start._tag === 'Date' && current._tag === 'Days') {
    return Result.succeed({
      _tag: 'Days',
      first: start.date,
      last: addDays(start.date, daysBetween(current.first, current.last)),
    });
  }
  if (start._tag === 'Instant' && current._tag === 'Times') {
    return Result.succeed({
      _tag: 'Times',
      startMs: start.ms,
      endMs: start.ms + (current.endMs - current.startMs),
    });
  }
  return Result.fail(
    'pass --end as well to turn an all-day event into a timed one or back',
  );
};
