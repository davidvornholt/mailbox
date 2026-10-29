import { describe, expect, it } from 'bun:test';
import { DateTime, Effect } from 'effect';
import {
  decodeGraphEvent,
  type GraphEvent,
  graphAttendees,
  graphCalendar,
  graphEventSummary,
  graphInstant,
  graphMentions,
  graphRecurrenceId,
  graphSpan,
} from './graph-events';

// Central European Time, UTC+1, in November 2026.
const berlin = DateTime.zoneMakeNamedUnsafe('Europe/Berlin');

const utc = (time: string) => ({ dateTime: time, timeZone: 'UTC' });

const meeting: GraphEvent = {
  id: 'event-1',
  iCalUId: 'uid-1',
  subject: 'Planning',
  start: utc('2026-11-03T13:00:00.0000000'),
  end: utc('2026-11-03T14:30:00.0000000'),
  isAllDay: false,
  isCancelled: false,
  location: { displayName: 'Room 4' },
  organizer: { emailAddress: { name: 'Ana', address: 'ana@example.com' } },
  attendees: [
    {
      type: 'required',
      status: { response: 'organizer' },
      emailAddress: { name: 'Ana', address: 'ana@example.com' },
    },
    {
      type: 'required',
      status: { response: 'accepted' },
      emailAddress: { name: 'Me', address: 'me@example.com' },
    },
  ],
  type: 'singleInstance',
  bodyPreview: 'Agenda: budget',
};

const allDay = (start: string, end: string): GraphEvent => ({
  id: 'event-2',
  subject: 'Offsite',
  start: utc(start),
  end: utc(end),
  isAllDay: true,
});

const spanOf = (event: GraphEvent) =>
  Effect.runPromise(Effect.result(graphSpan(event, berlin)));

describe('graphInstant', () => {
  it('reads a time without offset as UTC', () => {
    expect(graphInstant('2026-11-03T13:00:00.0000000')).toBe(
      Date.UTC(2026, 10, 3, 13),
    );
  });

  it('reads a time with Z or an offset', () => {
    expect(graphInstant('2026-11-03T13:00:00Z')).toBe(
      Date.UTC(2026, 10, 3, 13),
    );
    expect(graphInstant('2026-11-03T14:00:00+01:00')).toBe(
      Date.UTC(2026, 10, 3, 13),
    );
  });

  it('rejects anything else', () => {
    expect(graphInstant('2026-11-03')).toBeUndefined();
    expect(graphInstant('tomorrow')).toBeUndefined();
  });
});

describe('graphSpan', () => {
  it('gives a timed event local times with offset', async () => {
    expect(await spanOf(meeting)).toMatchObject({
      success: {
        start: '2026-11-03T14:00:00+01:00',
        end: '2026-11-03T15:30:00+01:00',
        allDay: false,
        startMs: Date.UTC(2026, 10, 3, 13),
        endMs: Date.UTC(2026, 10, 3, 14, 30),
      },
    });
  });

  it('gives an all-day event its first and last day', async () => {
    expect(
      await spanOf(
        allDay('2026-11-03T00:00:00.0000000', '2026-11-05T00:00:00.0000000'),
      ),
    ).toMatchObject({
      success: {
        start: '2026-11-03',
        end: '2026-11-04',
        allDay: true,
        startMs: Date.UTC(2026, 10, 2, 23),
        endMs: Date.UTC(2026, 10, 4, 23),
      },
    });
  });

  it('reads all-day boundaries converted from another zone as the nearest day', async () => {
    const days = async (start: string, end: string) => {
      const span = await spanOf(allDay(start, end));
      return span._tag === 'Success'
        ? [span.success.start, span.success.end]
        : [];
    };
    // Midnight in Berlin and in New York, converted to UTC.
    expect(
      await days('2026-11-02T23:00:00.0000000', '2026-11-03T23:00:00.0000000'),
    ).toEqual(['2026-11-03', '2026-11-03']);
    expect(
      await days('2026-11-03T05:00:00.0000000', '2026-11-04T05:00:00.0000000'),
    ).toEqual(['2026-11-03', '2026-11-03']);
  });

  it('rejects times in a zone pim did not ask for', async () => {
    expect(
      await spanOf({
        ...meeting,
        start: {
          dateTime: '2026-11-03T05:00:00.0000000',
          timeZone: 'Pacific Standard Time',
        },
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CalendarDataError',
        href: 'event-1',
        message:
          'Could not read Outlook event event-1: Microsoft Graph gave its times in Pacific Standard Time, not in UTC as pim asked',
      },
    });
  });

  it('rejects times that are not date-times', async () => {
    expect(await spanOf({ ...meeting, end: utc('soon') })).toMatchObject({
      failure: { _tag: 'CalendarDataError' },
    });
  });
});

describe('graphRecurrenceId', () => {
  it('gives an occurrence its original start', () => {
    expect(
      graphRecurrenceId(
        { type: 'occurrence', originalStart: '2026-11-03T13:00:00Z' },
        false,
        berlin,
      ),
    ).toBe('2026-11-03T14:00:00+01:00');
    expect(
      graphRecurrenceId(
        { type: 'exception', originalStart: '2026-11-03T00:00:00Z' },
        true,
        berlin,
      ),
    ).toBe('2026-11-03');
  });

  it('gives other events none', () => {
    expect(
      graphRecurrenceId(
        { type: 'singleInstance', originalStart: '2026-11-03T13:00:00Z' },
        false,
        berlin,
      ),
    ).toBeUndefined();
  });
});

describe('graphAttendees', () => {
  it('maps responses to participation states and the organizer to the chair', () => {
    const attendee = (
      type: string,
      response: string | null,
      address: string | null,
    ) => ({
      type,
      status: response === null ? null : { response },
      emailAddress: { name: null, address },
    });
    expect(
      graphAttendees({
        attendees: [
          attendee('required', 'organizer', 'ana@example.com'),
          attendee('required', 'accepted', 'bo@example.com'),
          attendee('optional', 'tentativelyAccepted', 'cy@example.com'),
          attendee('optional', 'declined', 'di@example.com'),
          attendee('required', 'none', 'ed@example.com'),
          attendee('required', 'notResponded', 'fay@example.com'),
          attendee('resource', null, 'room-4@example.com'),
          attendee('required', 'accepted', null),
        ],
      }),
    ).toEqual([
      { email: 'ana@example.com', role: 'chair', partstat: 'accepted' },
      {
        email: 'bo@example.com',
        role: 'req-participant',
        partstat: 'accepted',
      },
      {
        email: 'cy@example.com',
        role: 'opt-participant',
        partstat: 'tentative',
      },
      {
        email: 'di@example.com',
        role: 'opt-participant',
        partstat: 'declined',
      },
      {
        email: 'ed@example.com',
        role: 'req-participant',
        partstat: 'needs-action',
      },
      {
        email: 'fay@example.com',
        role: 'req-participant',
        partstat: 'needs-action',
      },
      { email: 'room-4@example.com' },
    ]);
  });
});

describe('graphEventSummary', () => {
  const summaryOf = async (event: GraphEvent) => {
    const span = await Effect.runPromise(graphSpan(event, berlin));
    return graphEventSummary(
      event,
      span,
      { account: 'me@example.com', calendar: 'Calendar' },
      berlin,
    );
  };

  it('describes a meeting', async () => {
    expect(await summaryOf(meeting)).toEqual({
      account: 'me@example.com',
      calendar: 'Calendar',
      href: 'event-1',
      uid: 'uid-1',
      summary: 'Planning',
      start: '2026-11-03T14:00:00+01:00',
      end: '2026-11-03T15:30:00+01:00',
      allDay: false,
      location: 'Room 4',
      organizer: 'ana@example.com',
      attendees: 2,
    });
  });

  it('marks a cancelled occurrence', async () => {
    expect(
      await summaryOf({
        ...meeting,
        isCancelled: true,
        type: 'exception',
        originalStart: '2026-11-03T13:00:00Z',
      }),
    ).toMatchObject({
      status: 'cancelled',
      recurrenceId: '2026-11-03T14:00:00+01:00',
    });
  });

  it('falls back to the id for an event without iCalendar uid', async () => {
    const { iCalUId: _uid, attendees: _attendees, ...plain } = meeting;
    const summary = await summaryOf(plain);
    expect(summary.uid).toBe('event-1');
    expect(summary).not.toHaveProperty('attendees');
  });
});

describe('graphMentions', () => {
  it('searches the subject, location, and description preview', () => {
    expect(graphMentions(meeting, 'planning')).toBe(true);
    expect(graphMentions(meeting, 'room 4')).toBe(true);
    expect(graphMentions(meeting, 'budget')).toBe(true);
    expect(graphMentions(meeting, 'holiday')).toBe(false);
  });
});

describe('graphCalendar', () => {
  it('maps the id, name, color, and edit access', () => {
    expect(
      graphCalendar('me@example.com', {
        id: 'cal-1',
        name: 'Team',
        hexColor: '#3a87ad',
        canEdit: false,
      }),
    ).toEqual({
      account: 'me@example.com',
      href: 'cal-1',
      name: 'Team',
      color: '#3a87ad',
      writable: false,
    });
  });

  it('leaves out an empty color and names a nameless calendar by its id', () => {
    expect(
      graphCalendar('me@example.com', { id: 'cal-2', name: '', hexColor: '' }),
    ).toEqual({ account: 'me@example.com', href: 'cal-2', name: 'cal-2' });
  });
});

describe('decodeGraphEvent', () => {
  it('names the event Microsoft Graph sent in an unexpected form', async () => {
    expect(
      await Effect.runPromise(
        Effect.result(decodeGraphEvent({ id: 'event-3', start: 'now' })),
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CalendarDataError',
        href: 'event-3',
        message:
          'Could not read Outlook event event-3: Microsoft Graph sent it in an unexpected form',
      },
    });
  });
});
