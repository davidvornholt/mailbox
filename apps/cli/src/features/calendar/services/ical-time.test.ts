import { describe, expect, it } from 'bun:test';
import { DateTime } from 'effect';
import ICAL from 'ical.js';
import {
  formatInstant,
  formatUtcStamp,
  instantOf,
  localDayWindow,
} from './ical-time';

const berlin = DateTime.zoneMakeNamedUnsafe('Europe/Berlin');

// The DTSTART of a one-event calendar, parsed as a server would send it.
const dtstart = (line: string, vtimezone: ReadonlyArray<string> = []) => {
  const vcalendar = new ICAL.Component(
    ICAL.parse(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        ...vtimezone,
        'BEGIN:VEVENT',
        'UID:x',
        line,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    ),
  );
  const property = vcalendar
    .getFirstSubcomponent('vevent')
    ?.getFirstProperty('dtstart');
  const tzid = property?.getParameter('tzid');
  return {
    time: property?.getFirstValue() as ICAL.Time,
    tzid: typeof tzid === 'string' ? tzid : undefined,
  };
};

const iso = (epochMillis: number) => new Date(epochMillis).toISOString();

// Outlook names zones the Windows way and embeds their rules.
const windowsZone = [
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16011028T030000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010325T020000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

describe('instantOf', () => {
  it('reads a UTC time as written', () => {
    const { time, tzid } = dtstart('DTSTART:20261027T130000Z');
    expect(iso(instantOf(time, tzid, berlin))).toBe('2026-10-27T13:00:00.000Z');
  });

  it.each([
    ['20261024T100000', '2026-10-24T08:00:00.000Z'],
    ['20261026T100000', '2026-10-26T09:00:00.000Z'],
  ])(
    'converts an IANA zone on either side of a DST change (%s)',
    (local, utc) => {
      const { time, tzid } = dtstart(`DTSTART;TZID=Europe/Berlin:${local}`);
      expect(iso(instantOf(time, tzid, berlin))).toBe(utc);
    },
  );

  it('converts an IANA zone other than the local one', () => {
    const { time, tzid } = dtstart(
      'DTSTART;TZID=America/New_York:20261027T100000',
    );
    expect(iso(instantOf(time, tzid, berlin))).toBe('2026-10-27T14:00:00.000Z');
  });

  it('uses an embedded VTIMEZONE for a zone name outside the IANA database', () => {
    const { time, tzid } = dtstart(
      'DTSTART;TZID=W. Europe Standard Time:20260715T100000',
      windowsZone,
    );
    expect(iso(instantOf(time, tzid, berlin))).toBe('2026-07-15T08:00:00.000Z');
  });

  it('reads floating times and dates in the local zone', () => {
    const floating = dtstart('DTSTART:20260715T100000');
    expect(iso(instantOf(floating.time, floating.tzid, berlin))).toBe(
      '2026-07-15T08:00:00.000Z',
    );
    const date = dtstart('DTSTART;VALUE=DATE:20261227');
    expect(iso(instantOf(date.time, date.tzid, berlin))).toBe(
      '2026-12-26T23:00:00.000Z',
    );
  });
});

describe('formatting', () => {
  it('formats an instant with the local offset and no milliseconds', () => {
    expect(formatInstant(Date.UTC(2026, 9, 27, 13, 0, 0, 250), berlin)).toBe(
      '2026-10-27T14:00:00+01:00',
    );
  });

  it('formats the UTC stamp that CalDAV time ranges use', () => {
    expect(formatUtcStamp(Date.UTC(2026, 9, 27, 13, 5, 9))).toBe(
      '20261027T130509Z',
    );
  });
});

describe('localDayWindow', () => {
  it('spans whole local days, including a 25-hour day', () => {
    const window = localDayWindow(
      { year: 2026, month: 10, day: 25 },
      { year: 2026, month: 10, day: 25 },
      berlin,
    );
    expect(iso(window.startMs)).toBe('2026-10-24T22:00:00.000Z');
    expect(iso(window.endMs)).toBe('2026-10-25T23:00:00.000Z');
  });
});
