import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import {
  type CalendarObject,
  eventDetail,
  parseCalendar,
} from './event-fields';
import { applyChanges, type EventChanges, newEventIcs } from './event-write';
import { berlin, icsOf, vevent, weeklySeries } from './ical.fixture';
import { parseReminder, type ReminderTime } from './reminders';

const nowMs = Date.parse('2026-10-28T09:15:00.250Z');

const minutesBefore = (
  minutes: number,
  related: 'start' | 'end' = 'start',
): ReminderTime => ({
  _tag: 'Relative',
  days: 0,
  seconds: -minutes * 60,
  related,
});

// The content lines of each VALARM in the text.
const alarmsIn = (ics: string): ReadonlyArray<ReadonlyArray<string>> =>
  ics
    .replaceAll('\r\n ', '')
    .split('BEGIN:VALARM\r\n')
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('\r\nEND:VALARM')).split('\r\n'));

const display = (trigger: string, description: string) => [
  'ACTION:DISPLAY',
  trigger,
  `DESCRIPTION:${description}`,
];

const call = (endMs: number) =>
  newEventIcs(
    {
      uid: 'u1',
      title: 'Call',
      span: {
        _tag: 'Times',
        startMs: Date.parse('2026-10-28T13:30:00Z'),
        endMs,
      },
      reminders: [
        minutesBefore(15),
        minutesBefore(10, 'end'),
        { _tag: 'Relative', days: 0, seconds: 300, related: 'start' },
        { _tag: 'Relative', days: -1, seconds: 0, related: 'start' },
        { _tag: 'Absolute', ms: Date.parse('2026-10-28T18:00:00+01:00') },
      ],
    },
    nowMs,
  );

describe('newEventIcs with reminders', () => {
  it('writes a display alarm with the title for each reminder', () => {
    expect(alarmsIn(call(Date.parse('2026-10-28T14:00:00Z')))).toEqual([
      display('TRIGGER:-PT15M', 'Call'),
      display('TRIGGER;RELATED=END:-PT10M', 'Call'),
      display('TRIGGER:PT5M', 'Call'),
      display('TRIGGER:-P1D', 'Call'),
      display('TRIGGER;VALUE=DATE-TIME:20261028T170000Z', 'Call'),
    ]);
  });

  it('writes a reminder before the end of a zero-length event as before its start', () => {
    const [, fromEnd] = alarmsIn(call(Date.parse('2026-10-28T13:30:00Z')));
    expect(fromEnd).toEqual(display('TRIGGER:-PT10M', 'Call'));
  });
});

const objectOf = (...content: ReadonlyArray<string>): CalendarObject =>
  Effect.runSync(parseCalendar('/a.ics', icsOf(...content)));

const changed = (object: CalendarObject, changes: EventChanges) => {
  const result = applyChanges(object, changes, berlin, nowMs);
  return { result, ics: object.vcalendar.toString() };
};

const alarm = (...lines: ReadonlyArray<string>) => [
  'BEGIN:VALARM',
  ...lines,
  'END:VALARM',
];

const planning = (...alarms: ReadonlyArray<string>) =>
  vevent(
    'UID:p@example.com',
    'DTSTAMP:20261001T000000Z',
    'SEQUENCE:2',
    'SUMMARY:Planning',
    'DTSTART:20261028T090000Z',
    'DTEND:20261028T100000Z',
    ...alarms,
  );

describe('applyChanges to reminders', () => {
  const reminded = planning(
    ...alarm('ACTION:AUDIO', 'TRIGGER:-PT15M'),
    ...alarm('ACTION:DISPLAY', 'TRIGGER:-P1D', 'DESCRIPTION:Tomorrow'),
  );

  it('replaces every reminder and keeps the sequence', () => {
    const { result, ics } = changed(objectOf(...reminded), {
      reminders: [minutesBefore(30)],
    });
    expect(result).toEqual(Result.void);
    expect(alarmsIn(ics)).toEqual([display('TRIGGER:-PT30M', 'Planning')]);
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('DTSTAMP:20261028T091500Z');
  });

  it('removes every reminder', () => {
    const { result, ics } = changed(objectOf(...reminded), { reminders: [] });
    expect(result).toEqual(Result.void);
    expect(ics).not.toContain('VALARM');
    expect(ics).toContain('DTSTAMP:20261028T091500Z');
  });

  it('shows the new title in the new reminders', () => {
    const { ics } = changed(objectOf(...reminded), {
      title: 'Review',
      reminders: [minutesBefore(0)],
    });
    expect(alarmsIn(ics)).toEqual([display('TRIGGER:PT0S', 'Review')]);
  });

  it('writes a reminder before the end of an all-day event without an end from its start', () => {
    const { ics } = changed(
      objectOf(
        ...vevent(
          'UID:d@example.com',
          'DTSTAMP:20261001T000000Z',
          'SUMMARY:Holiday',
          'DTSTART;VALUE=DATE:20261030',
        ),
      ),
      { reminders: [minutesBefore(60, 'end')] },
    );
    expect(alarmsIn(ics)).toEqual([display('TRIGGER:PT23H', 'Holiday')]);
  });

  it('replaces the reminders of a series and of the occurrences that kept them', () => {
    const occurrence = (day: string, ...alarms: ReadonlyArray<string>) =>
      vevent(
        'UID:series@example.com',
        `RECURRENCE-ID;TZID=Europe/Berlin:202610${day}T100000`,
        `DTSTART;TZID=Europe/Berlin:202610${day}T120000`,
        `DTEND;TZID=Europe/Berlin:202610${day}T130000`,
        'SUMMARY:Weekly sync',
        ...alarms,
      );
    const { result, ics } = changed(
      objectOf(
        ...weeklySeries.slice(0, -1),
        ...alarm('ACTION:DISPLAY', 'TRIGGER:-PT30S', 'DESCRIPTION:Sync'),
        'END:VEVENT',
        ...occurrence(
          '20',
          ...alarm('ACTION:DISPLAY', 'TRIGGER:-PT30S', 'DESCRIPTION:Other'),
        ),
        // Its own reminder, though both print as 1m before start.
        ...occurrence('27', ...alarm('ACTION:DISPLAY', 'TRIGGER:-PT60S')),
      ),
      { reminders: [minutesBefore(60)] },
    );
    expect(result).toEqual(Result.void);
    expect(alarmsIn(ics).map((lines) => lines[1])).toEqual([
      'TRIGGER:-PT1H',
      'TRIGGER:-PT1H',
      'TRIGGER:-PT60S',
    ]);
  });
});

describe('eventDetail', () => {
  it('lists each reminder in the form --reminder takes and writes back, with any action other than display', () => {
    const detail = eventDetail(
      objectOf(
        ...planning(
          ...alarm('ACTION:DISPLAY', 'TRIGGER:-PT15M'),
          ...alarm('ACTION:AUDIO', 'TRIGGER;RELATED=END:PT10M'),
          ...alarm('ACTION:EMAIL', 'TRIGGER;VALUE=DATE-TIME:20261110T170000Z'),
          ...alarm('ACTION:DISPLAY', 'TRIGGER:-P1DT2H'),
          // Days are nominal and hours exact (RFC 5545, section 3.3.6): for
          // a start at 10:00 on 2026-03-29, when daylight saving time starts
          // in Berlin, 1d before is 10:00 and 24h before 09:00 the day before.
          ...alarm('ACTION:DISPLAY', 'TRIGGER:-P1D'),
          ...alarm('ACTION:DISPLAY', 'TRIGGER:-PT24H'),
          ...alarm('ACTION:DISPLAY', 'TRIGGER:-PT30S'),
          ...alarm('ACTION:DISPLAY', 'TRIGGER:PT0S'),
          ...alarm('ACTION:DISPLAY'),
        ),
      ),
      { account: 'me@example.com', href: '/a.ics', etag: undefined },
      berlin,
    );
    expect(detail.reminders).toEqual([
      { when: '15m before start' },
      { when: '10m after end', action: 'audio' },
      { when: '2026-11-10T18:00:00+01:00', action: 'email' },
      { when: '1d2h before start' },
      { when: '1d before start' },
      { when: '24h before start' },
      { when: '1m before start' },
      { when: '0m before start' },
    ]);
    const { ics } = changed(objectOf(...planning()), {
      reminders: detail.reminders.map(({ when }) =>
        Result.getOrThrow(parseReminder(when, berlin)),
      ),
    });
    expect(alarmsIn(ics).map((lines) => lines[1])).toEqual([
      'TRIGGER:-PT15M',
      'TRIGGER;RELATED=END:PT10M',
      'TRIGGER;VALUE=DATE-TIME:20261110T170000Z',
      'TRIGGER:-P1DT2H',
      'TRIGGER:-P1D',
      'TRIGGER:-PT24H',
      'TRIGGER:-PT1M',
      'TRIGGER:PT0S',
    ]);
  });
});
