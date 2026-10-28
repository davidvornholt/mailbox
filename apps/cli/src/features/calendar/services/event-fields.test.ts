import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { eventDetail, eventSummary, parseCalendar } from './event-fields';
import { berlin, icsOf, vevent, weeklySeries, windowOf } from './ical.fixture';
import { occurrencesIn } from './occurrences';

const context = {
  account: 'me@example.com',
  calendar: 'Work',
  href: '/calendars/me/work/a.ics',
};

const parsed = (...lines: ReadonlyArray<string>) =>
  Effect.runSync(parseCalendar(context.href, icsOf(...lines)));

const meeting = vevent(
  'UID:meeting@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Budget review',
  'LOCATION:Room 4',
  'STATUS:CONFIRMED',
  'DTSTART:20261027T130000Z',
  'DTEND:20261027T140000Z',
  'ORGANIZER;CN=Ana Boss:mailto:ana@example.com',
  'ATTENDEE;CN=Me;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:MAILTO:bo@example.com',
);

describe('parseCalendar', () => {
  it('rejects text that is not iCalendar data', () => {
    const error = Effect.runSync(
      Effect.flip(parseCalendar(context.href, 'not a calendar')),
    );
    expect(error._tag).toBe('CalendarDataError');
    expect(error.message).toContain('is not valid iCalendar data');
  });

  it('rejects a calendar object without an event', () => {
    const error = Effect.runSync(
      Effect.flip(
        parseCalendar(
          context.href,
          icsOf('BEGIN:VTODO', 'UID:t', 'SUMMARY:Task', 'END:VTODO'),
        ),
      ),
    );
    expect(error.message).toContain('holds no event (VEVENT)');
  });
});

describe('eventSummary', () => {
  it('describes a timed event in the local zone', () => {
    const { vcalendar } = parsed(...meeting);
    const [occurrence] = occurrencesIn(
      vcalendar,
      windowOf('2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z'),
      berlin,
    );
    expect(
      occurrence === undefined
        ? undefined
        : eventSummary(occurrence, context, berlin),
    ).toEqual({
      ...context,
      uid: 'meeting@example.com',
      summary: 'Budget review',
      start: '2026-10-27T14:00:00+01:00',
      end: '2026-10-27T15:00:00+01:00',
      allDay: false,
      location: 'Room 4',
      status: 'confirmed',
      organizer: 'ana@example.com',
      attendees: 2,
    });
  });

  it('gives an all-day event its dates, with the last day included', () => {
    const { vcalendar } = parsed(
      ...vevent(
        'UID:trip@example.com',
        'DTSTAMP:20261001T000000Z',
        'SUMMARY:Trip',
        'DTSTART;VALUE=DATE:20261027',
        'DTEND;VALUE=DATE:20261030',
      ),
    );
    const [occurrence] = occurrencesIn(
      vcalendar,
      windowOf('2026-10-28T00:00:00Z', '2026-10-29T00:00:00Z'),
      berlin,
    );
    expect(
      occurrence === undefined
        ? undefined
        : eventSummary(occurrence, context, berlin),
    ).toMatchObject({ start: '2026-10-27', end: '2026-10-29', allDay: true });
  });

  it('counts the hours of a duration as exact time across a DST change', () => {
    const object = parsed(
      ...vevent(
        'UID:night@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART;TZID=Europe/Berlin:20260329T013000',
        'DURATION:PT3H',
      ),
    );
    const [occurrence] = occurrencesIn(
      object.vcalendar,
      windowOf('2026-03-29T00:00:00Z', '2026-03-30T00:00:00Z'),
      berlin,
    );
    const end = '2026-03-29T05:30:00+02:00';
    expect(occurrence && eventSummary(occurrence, context, berlin).end).toBe(
      end,
    );
    expect(
      eventDetail(object, { ...context, etag: undefined }, berlin).end,
    ).toBe(end);
  });
});

describe('eventDetail', () => {
  it('lists the organizer and attendees with their replies', () => {
    const detail = eventDetail(
      parsed(...meeting),
      { ...context, etag: '"1"' },
      berlin,
    );
    expect(detail.etag).toBe('"1"');
    expect(detail.timeZone).toBe('UTC');
    expect(detail.organizer).toEqual({
      email: 'ana@example.com',
      name: 'Ana Boss',
    });
    expect(detail.attendees).toEqual([
      {
        email: 'me@example.com',
        name: 'Me',
        role: 'req-participant',
        partstat: 'needs-action',
        rsvp: true,
      },
      { email: 'bo@example.com', partstat: 'accepted' },
    ]);
    expect(detail.recurrence).toBeUndefined();
  });

  it('describes a series by its rule, exclusions, and changed occurrences', () => {
    const detail = eventDetail(
      parsed(
        ...weeklySeries.slice(0, -1),
        'EXDATE;TZID=Europe/Berlin:20261103T100000',
        'END:VEVENT',
        ...vevent(
          'UID:series@example.com',
          'DTSTAMP:20261001T000000Z',
          'SUMMARY:Weekly sync',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
          'DTSTART;TZID=Europe/Berlin:20261027T150000',
          'DTEND;TZID=Europe/Berlin:20261027T160000',
          'STATUS:CANCELLED',
          'ATTENDEE:mailto:hidden@example.com',
        ),
      ),
      { ...context, etag: undefined },
      berlin,
    );
    expect(detail).toMatchObject({
      summary: 'Weekly sync',
      start: '2026-10-20T10:00:00+02:00',
      end: '2026-10-20T11:00:00+02:00',
      timeZone: 'Europe/Berlin',
      recurrence: {
        rule: 'FREQ=WEEKLY;COUNT=3',
        excluded: ['2026-11-03T10:00:00+01:00'],
        changed: [
          {
            recurrenceId: '2026-10-27T10:00:00+01:00',
            start: '2026-10-27T15:00:00+01:00',
            end: '2026-10-27T16:00:00+01:00',
            status: 'cancelled',
            attendees: ['hidden@example.com'],
          },
        ],
      },
    });
    expect(detail.recurrence?.changed[0]?.summary).toBeUndefined();
  });

  it('lists the changed occurrences of a series without a rule', () => {
    const detail = eventDetail(
      parsed(
        ...vevent(
          'UID:dates@example.com',
          'DTSTAMP:20261001T000000Z',
          'SUMMARY:Workshop',
          'DTSTART:20261020T090000Z',
          'DTEND:20261020T100000Z',
          'RDATE:20261027T090000Z',
        ),
        ...vevent(
          'UID:dates@example.com',
          'DTSTAMP:20261001T000000Z',
          'RECURRENCE-ID:20261027T090000Z',
          'DTSTART:20261027T090000Z',
          'DTEND:20261027T100000Z',
          'ATTENDEE:mailto:hidden@example.com',
        ),
      ),
      { ...context, etag: undefined },
      berlin,
    );
    expect(detail.recurrence).toEqual({
      excluded: [],
      changed: [expect.objectContaining({ attendees: ['hidden@example.com'] })],
    });
  });
});
