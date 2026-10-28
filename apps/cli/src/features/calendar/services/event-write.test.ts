import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import { type CalendarObject, parseCalendar } from './event-fields';
import {
  applyChanges,
  type EventChanges,
  newEventIcs,
  otherAttendees,
} from './event-write';
import {
  berlin,
  icsOf,
  vcalendarOf,
  vevent,
  weeklySeries,
} from './ical.fixture';

const nowMs = Date.parse('2026-10-28T09:15:00.250Z');

const lines = (ics: string) => ics.split('\r\n');
const invitation = /ORGANIZER|ATTENDEE|VALARM/u;
const oldDescription = /LOCATION|X-ALT-DESC|ALTREP/u;

describe('newEventIcs', () => {
  it('writes an all-day event that invites no one', () => {
    const ics = newEventIcs(
      {
        uid: 'u1',
        title: 'Trip; Berlin, Hamburg',
        span: {
          _tag: 'Days',
          first: { year: 2026, month: 10, day: 30 },
          last: { year: 2026, month: 11, day: 1 },
        },
        location: 'Hauptbahnhof',
      },
      nowMs,
    );
    expect(lines(ics)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//pim//EN',
      'BEGIN:VEVENT',
      'UID:u1',
      'DTSTAMP:20261028T091500Z',
      'CREATED:20261028T091500Z',
      'LAST-MODIFIED:20261028T091500Z',
      'DTSTART;VALUE=DATE:20261030',
      'DTEND;VALUE=DATE:20261102',
      'SUMMARY:Trip\\; Berlin\\, Hamburg',
      'LOCATION:Hauptbahnhof',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
  });

  it('writes a timed event in UTC', () => {
    const ics = newEventIcs(
      {
        uid: 'u2',
        title: 'Call',
        span: {
          _tag: 'Times',
          startMs: Date.parse('2026-10-28T13:30:00Z'),
          endMs: Date.parse('2026-10-28T14:00:00Z'),
        },
        description: 'Agenda:\nfirst',
      },
      nowMs,
    );
    expect(lines(ics)).toContain('DTSTART:20261028T133000Z');
    expect(lines(ics)).toContain('DTEND:20261028T140000Z');
    expect(lines(ics)).toContain('DESCRIPTION:Agenda:\\nfirst');
    expect(ics).not.toMatch(invitation);
  });
});

describe('otherAttendees', () => {
  it.each([
    ['no attendees', vevent('UID:a', 'ORGANIZER:mailto:me@example.com'), []],
    [
      'only the organizer',
      vevent(
        'UID:a',
        'ORGANIZER:mailto:me@example.com',
        'ATTENDEE:MAILTO:Me@Example.com',
      ),
      [],
    ],
    [
      'a guest',
      vevent(
        'UID:a',
        'ORGANIZER:mailto:me@example.com',
        'ATTENDEE:mailto:me@example.com',
        'ATTENDEE;CN=Ana:mailto:ana@example.com',
      ),
      ['ana@example.com'],
    ],
    [
      'an invitation from someone else',
      vevent(
        'UID:a',
        'ORGANIZER:mailto:boss@example.com',
        'ATTENDEE:mailto:me@example.com',
      ),
      ['me@example.com'],
    ],
    [
      'an attendee without an organizer',
      vevent('UID:a', 'ATTENDEE:mailto:me@example.com'),
      ['me@example.com'],
    ],
  ])('finds %s', (_name, event, expected) => {
    expect(otherAttendees(vcalendarOf(...event))).toEqual(expected);
  });

  it('checks every occurrence of a series', () => {
    expect(
      otherAttendees(
        vcalendarOf(
          ...weeklySeries,
          ...vevent(
            'UID:series@example.com',
            'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
            'DTSTART;TZID=Europe/Berlin:20261027T120000',
            'DTEND;TZID=Europe/Berlin:20261027T130000',
            'ATTENDEE:mailto:guest@example.com',
          ),
        ),
      ),
    ).toEqual(['guest@example.com']);
  });
});

const objectOf = (...content: ReadonlyArray<string>): CalendarObject =>
  Effect.runSync(parseCalendar('/a.ics', icsOf(...content)));

const changed = (object: CalendarObject, changes: EventChanges) => {
  const result = applyChanges(object, changes, berlin, nowMs);
  return { result, ics: lines(object.vcalendar.toString()) };
};

const meeting = vevent(
  'UID:m@example.com',
  'DTSTAMP:20261001T000000Z',
  'LAST-MODIFIED:20261001T000000Z',
  'SEQUENCE:2',
  'SUMMARY:Planning',
  'LOCATION:Room 1',
  'DESCRIPTION;ALTREP="cid:part1":Old notes',
  'X-ALT-DESC;FMTTYPE=text/html:<p>Old notes</p>',
  'DTSTART;TZID=Europe/Berlin:20261028T100000',
  'DURATION:PT1H30M',
  'X-PIM-TEST:kept',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
);

describe('applyChanges', () => {
  it('replaces and removes text and keeps everything else', () => {
    const { result, ics } = changed(objectOf(...meeting), {
      title: 'Planning, final',
      location: '',
      description: 'New notes',
    });
    expect(result).toEqual(Result.void);
    expect(ics).toContain('SUMMARY:Planning\\, final');
    expect(ics).toContain('DESCRIPTION:New notes');
    expect(ics.join('\n')).not.toMatch(oldDescription);
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20261028T100000');
    expect(ics).toContain('DURATION:PT1H30M');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('X-PIM-TEST:kept');
    expect(ics).toContain('TRIGGER:-PT15M');
    expect(ics).toContain('DTSTAMP:20261028T091500Z');
    expect(ics).toContain('LAST-MODIFIED:20261028T091500Z');
  });

  it('moves an event in UTC and keeps its length', () => {
    const { result, ics } = changed(objectOf(...meeting), {
      start: { _tag: 'Instant', ms: Date.parse('2026-10-29T08:00:00Z') },
    });
    expect(result).toEqual(Result.void);
    expect(ics).toContain('DTSTART:20261029T080000Z');
    expect(ics).toContain('DTEND:20261029T093000Z');
    expect(ics.join('\n')).not.toContain('DURATION');
    expect(ics).toContain('SEQUENCE:3');
    expect(ics).toContain('SUMMARY:Planning');
  });

  it('turns a timed event into an all-day one', () => {
    const { result, ics } = changed(objectOf(...meeting), {
      start: { _tag: 'Date', date: { year: 2026, month: 10, day: 29 } },
      end: { _tag: 'Date', date: { year: 2026, month: 10, day: 29 } },
    });
    expect(result).toEqual(Result.void);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261029');
    expect(ics).toContain('DTEND;VALUE=DATE:20261030');
  });

  it('leaves the event alone when the new times do not fit', () => {
    const object = objectOf(...meeting);
    const before = object.vcalendar.toString();
    const { result } = changed(object, {
      title: 'Never written',
      end: { _tag: 'Instant', ms: Date.parse('2026-10-28T08:00:00Z') },
    });
    expect(result).toEqual(Result.fail('--end must be after --start'));
    expect(object.vcalendar.toString()).toBe(before);
  });

  const series = [
    ...weeklySeries,
    ...vevent(
      'UID:series@example.com',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
      'DTSTART;TZID=Europe/Berlin:20261027T120000',
      'DTEND;TZID=Europe/Berlin:20261027T130000',
      'SUMMARY:Weekly sync',
    ),
    ...vevent(
      'UID:series@example.com',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261103T100000',
      'DTSTART;TZID=Europe/Berlin:20261103T100000',
      'DTEND;TZID=Europe/Berlin:20261103T110000',
      'SUMMARY:Sync with guests',
    ),
  ];

  it('renames a series and the occurrences that kept its title', () => {
    const { result, ics } = changed(objectOf(...series), {
      title: 'Team sync',
    });
    expect(result).toEqual(Result.void);
    expect(ics.filter((line) => line.startsWith('SUMMARY:'))).toEqual([
      'SUMMARY:Team sync',
      'SUMMARY:Team sync',
      'SUMMARY:Sync with guests',
    ]);
  });

  it('does not move a recurring event', () => {
    const { result } = changed(objectOf(...series), {
      start: { _tag: 'Instant', ms: Date.parse('2026-10-20T09:00:00Z') },
    });
    expect(Result.isFailure(result) && result.failure).toContain(
      'pim does not move recurring events',
    );
  });
});
