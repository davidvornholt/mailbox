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

const partsOf = (time: ICAL.Time): Parts => ({
  year: time.year,
  month: time.month,
  day: time.day,
  hour: time.isDate ? 0 : time.hour,
  minute: time.isDate ? 0 : time.minute,
  second: time.isDate ? 0 : time.second,
});

// A zone whose offsets come from the runtime's time zone database.
class IanaZone extends ICAL.Timezone {
  readonly #zone: DateTime.TimeZone;

  constructor(tzid: string, zone: DateTime.TimeZone) {
    super({ tzid });
    this.#zone = zone;
  }

  override utcOffset(time: ICAL.Time): number {
    const parts = partsOf(time);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    return (asUtc - zonedMillis(parts, this.#zone)) / millisPerSecond;
  }
}

// ical.js leaves a time floating when its TZID has no VTIMEZONE in the
// calendar data, and so compares it wrongly with UNTIL, EXDATE, and
// RECURRENCE-ID values in UTC. It falls back to the zones registered with
// its TimezoneService, so this registers each IANA zone the calendar names.
// ical.js reads values lazily, so this must run before any time is read.
export const registerIanaZones = (vcalendar: ICAL.Component): void => {
  for (const component of vcalendar.getAllSubcomponents()) {
    for (const property of component.getAllProperties()) {
      const tzid = property.getParameter('tzid');
      // Unlike has(), get() first sets up ical.js's own UTC zone, which
      // this mustn't replace.
      if (
        typeof tzid === 'string' &&
        ICAL.TimezoneService.get(tzid) === undefined
      ) {
        const named = DateTime.zoneMakeNamed(tzid);
        if (Option.isSome(named)) {
          ICAL.TimezoneService.register(new IanaZone(tzid, named.value), tzid);
        }
      }
    }
  }
};

const isUtc = (time: ICAL.Time): boolean => time.zone?.tzid === 'UTC';

// ical.js resolves a TZID outside the IANA database only when the calendar
// data embeds its VTIMEZONE; otherwise the time is left floating.
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
  const parts = partsOf(time);
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

const utc = DateTime.zoneMakeOffset(0);

// A RECURRENCE-ID or EXDATE value as the instant it stands for, so that the
// same occurrence matches in UTC and in any zone.
export const timeKey = (value: unknown, tzid: unknown): string => {
  if (!(value instanceof ICAL.Time)) {
    return String(value);
  }
  return value.isDate
    ? formatDate(value)
    : String(
        instantOf(value, typeof tzid === 'string' ? tzid : undefined, utc),
      );
};

// Adds the zones of the other calendar data that this one lacks, so that
// the times of both resolve alike.
export const addTimezones = (
  vcalendar: ICAL.Component,
  from: ICAL.Component,
): void => {
  const known = new Set(
    vcalendar
      .getAllSubcomponents('vtimezone')
      .map((zone) => String(zone.getFirstPropertyValue('tzid'))),
  );
  for (const zone of from.getAllSubcomponents('vtimezone')) {
    if (!known.has(String(zone.getFirstPropertyValue('tzid')))) {
      vcalendar.addSubcomponent(
        new ICAL.Component(ICAL.parse(zone.toString())),
      );
    }
  }
};
