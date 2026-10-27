import { DateTime } from 'effect';
import ICAL from 'ical.js';

export const berlin = DateTime.zoneMakeNamedUnsafe('Europe/Berlin');

// The text of a VCALENDAR around the given lines, such as whole VEVENTs.
export const icsOf = (...lines: ReadonlyArray<string>): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//pim tests//EN',
    ...lines,
    'END:VCALENDAR',
  ].join('\r\n');

export const vcalendarOf = (...lines: ReadonlyArray<string>): ICAL.Component =>
  new ICAL.Component(ICAL.parse(icsOf(...lines)));

export const vevent = (
  ...lines: ReadonlyArray<string>
): ReadonlyArray<string> => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

// A weekly series of three Tuesday meetings at 10:00 Berlin time, which
// spans the end of daylight saving time on 2026-10-25.
export const weeklySeries = vevent(
  'UID:series@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Weekly sync',
  'DTSTART;TZID=Europe/Berlin:20261020T100000',
  'DTEND;TZID=Europe/Berlin:20261020T110000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
);

export const windowOf = (from: string, to: string) => ({
  startMs: Date.parse(from),
  endMs: Date.parse(to),
});
