import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import { type CalendarObject, parseCalendar } from './event-fields';
import { applyChanges, type EventChanges, newEventIcs } from './event-write';
import { berlin, icsOf, vevent, weeklySeries } from './ical.fixture';

const nowMs = Date.parse('2026-10-28T09:15:00.250Z');

// The content lines of the text, with folded lines joined again.
const lines = (ics: string) => ics.replaceAll('\r\n ', '').split('\r\n');
const invitation = /ORGANIZER|ATTENDEE|VALARM/u;
const oldDescription = /LOCATION|X-ALT-DESC|ALTREP/u;
const endOrDuration = /DTEND|DURATION/u;

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

  it('writes an invitation without alarms', () => {
    const ics = newEventIcs(
      {
        uid: 'u3',
        title: 'Planning',
        span: {
          _tag: 'Times',
          startMs: Date.parse('2026-10-28T13:30:00Z'),
          endMs: Date.parse('2026-10-28T14:00:00Z'),
        },
        invitation: {
          organizer: { email: 'me@example.com', name: 'Me, Myself' },
          attendees: ['ana@example.com', 'bo@example.org'],
        },
      },
      nowMs,
    );
    expect(lines(ics)).toContain(
      'ORGANIZER;CN="Me, Myself":mailto:me@example.com',
    );
    expect(lines(ics)).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com',
    );
    expect(lines(ics)).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.org',
    );
    expect(ics).not.toContain('VALARM');
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

  it('moves a zero-length event without writing an end', () => {
    const { result, ics } = changed(
      objectOf(
        ...vevent(
          'UID:z@example.com',
          'DTSTAMP:20261001T000000Z',
          'SUMMARY:Reminder',
          'DTSTART;TZID=Europe/Berlin:20261028T100000',
        ),
      ),
      { start: { _tag: 'Instant', ms: Date.parse('2026-10-29T08:00:00Z') } },
    );
    expect(result).toEqual(Result.void);
    expect(ics).toContain('DTSTART:20261029T080000Z');
    expect(ics.join('\n')).not.toMatch(endOrDuration);
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

describe('applyChanges to a meeting', () => {
  const guests = [
    'ORGANIZER;CN=Me:mailto:me@example.com',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com',
    'ATTENDEE;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:ana@example.com',
  ];

  it('asks the attendees of a moved meeting to reply again', () => {
    const { result, ics } = changed(
      objectOf(...meeting.slice(0, -1), ...guests, 'END:VEVENT'),
      {
        start: { _tag: 'Instant', ms: Date.parse('2026-10-29T08:00:00Z') },
      },
    );
    expect(result).toEqual(Result.void);
    expect(ics).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com');
    expect(ics).toContain(
      'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com',
    );
  });

  it('invites and takes off attendees on the series and its occurrences', () => {
    const withGuests = (event: ReadonlyArray<string>) => [
      ...event.slice(0, -1),
      ...guests,
      'END:VEVENT',
    ];
    const { result, ics } = changed(
      objectOf(
        ...withGuests(weeklySeries),
        ...withGuests(
          vevent(
            'UID:series@example.com',
            'DTSTAMP:20261001T000000Z',
            'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
            'DTSTART;TZID=Europe/Berlin:20261027T120000',
            'DTEND;TZID=Europe/Berlin:20261027T130000',
          ),
        ),
      ),
      {
        addAttendees: ['bo@example.org'],
        removeAttendees: ['ANA@example.com'],
      },
    );
    expect(result).toEqual(Result.void);
    expect(ics.filter((line) => line.startsWith('ATTENDEE'))).toEqual([
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com',
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.org',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com',
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bo@example.org',
    ]);
    expect(
      ics.filter((line) => line === 'DTSTAMP:20261028T091500Z'),
    ).toHaveLength(2);
  });

  it('leaves the event alone when an attendee change does not apply', () => {
    const object = objectOf(...meeting.slice(0, -1), ...guests, 'END:VEVENT');
    const before = object.vcalendar.toString();
    const { result } = changed(object, {
      title: 'Never written',
      removeAttendees: ['bo@example.org'],
    });
    expect(result).toEqual(Result.fail('bo@example.org is not an attendee'));
    expect(object.vcalendar.toString()).toBe(before);
  });
});
