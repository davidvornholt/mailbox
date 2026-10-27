import { DateTime, Option } from 'effect';
import ICAL from 'ical.js';
import { addDays, type CalendarDate } from './calendar-dates';

// A local time window, as epoch milliseconds, for "events between" queries.
export type TimeWindow = {
  readonly startMs: number;
  readonly endMs: number;
};

type Parts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

const zonedMillis = (parts: Parts, zone: DateTime.TimeZone): number =>
  Option.match(
    DateTime.makeZoned(parts, { timeZone: zone, adjustForTimeZone: true }),
    {
      onNone: () =>
        Date.UTC(
          parts.year,
          parts.month - 1,
          parts.day,
          parts.hour,
          parts.minute,
          parts.second,
        ),
      onSome: DateTime.toEpochMillis,
    },
  );

const millisPerSecond = 1000;

const isUtc = (time: ICAL.Time): boolean => time.zone?.tzid === 'UTC';

// ical.js resolves a TZID only when the calendar data embeds its VTIMEZONE;
// otherwise the time is left floating.
const hasResolvedZone = (time: ICAL.Time): boolean =>
  time.zone !== undefined &&
  time.zone.tzid !== 'floating' &&
  time.zone !== ICAL.Timezone.localTimezone;

// The instant an iCalendar time stands for. A TZID that names an IANA zone
// is converted with the runtime's time zone database, which is more current
// than an embedded VTIMEZONE. Other TZIDs, such as Outlook's Windows names,
// rely on the embedded VTIMEZONE; floating times and dates are local.
export const instantOf = (
  time: ICAL.Time,
  tzid: string | undefined,
  local: DateTime.TimeZone,
): number => {
  if (!time.isDate && isUtc(time)) {
    return time.toUnixTime() * millisPerSecond;
  }
  const parts: Parts = {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
  const named =
    time.isDate || tzid === undefined
      ? Option.none()
      : DateTime.zoneMakeNamed(tzid);
  if (Option.isSome(named)) {
    return zonedMillis(parts, named.value);
  }
  if (!time.isDate && hasResolvedZone(time)) {
    return time.toUnixTime() * millisPerSecond;
  }
  return zonedMillis(parts, local);
};

const twoDigits = (value: number): string => String(value).padStart(2, '0');

export const formatDate = (time: ICAL.Time): string =>
  `${time.year}-${twoDigits(time.month)}-${twoDigits(time.day)}`;

const milliseconds = /\.\d{3}(?=[+-]|Z$)/u;

// Like 2026-10-27T14:00:00+01:00, in the given zone.
export const formatInstant = (
  epochMillis: number,
  zone: DateTime.TimeZone,
): string =>
  DateTime.formatIsoOffset(
    DateTime.setZone(DateTime.makeUnsafe(epochMillis), zone),
  ).replace(milliseconds, '');

// The UTC form CalDAV time-range filters expect, like 20261027T130000Z.
export const formatUtcStamp = (epochMillis: number): string =>
  new Date(epochMillis).toISOString().replace(/[-:]|\.\d{3}/gu, '');

// The window from the start of `from` to the end of `to`, both local dates.
export const localDayWindow = (
  from: CalendarDate,
  to: CalendarDate,
  local: DateTime.TimeZone,
): TimeWindow => {
  const midnight = { hour: 0, minute: 0, second: 0 };
  return {
    startMs: zonedMillis({ ...from, ...midnight }, local),
    endMs: zonedMillis({ ...addDays(to, 1), ...midnight }, local),
  };
};
