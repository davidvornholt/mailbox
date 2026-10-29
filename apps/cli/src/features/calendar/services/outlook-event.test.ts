import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import { berlin } from './ical.fixture';
import {
  allowsTeams,
  changedAttendees,
  graphText,
  graphTimes,
  notifiedAttendees,
} from './outlook-event';

const meeting = {
  organizer: { emailAddress: { address: 'me@example.com' } },
  attendees: [
    {
      emailAddress: { address: 'me@example.com' },
      status: { response: 'organizer' },
    },
    {
      emailAddress: { address: 'ann@example.com', name: 'Ann' },
      type: 'optional',
      status: { response: 'accepted' },
    },
    { emailAddress: { address: 'bob@example.com' }, type: 'required' },
  ],
};

describe('graphTimes', () => {
  it('writes a timed event as wall-clock times in its zone', () => {
    expect(
      graphTimes(
        {
          _tag: 'Times',
          startMs: Date.parse('2026-11-17T13:00:00Z'),
          endMs: Date.parse('2026-11-17T14:30:00Z'),
        },
        berlin,
      ),
    ).toEqual({
      isAllDay: false,
      start: { dateTime: '2026-11-17T14:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-11-17T15:30:00', timeZone: 'Europe/Berlin' },
    });
  });

  it('ends an all-day event at midnight after its last day', () => {
    expect(
      graphTimes(
        {
          _tag: 'Days',
          first: { year: 2026, month: 12, day: 30 },
          last: { year: 2026, month: 12, day: 31 },
        },
        berlin,
      ),
    ).toEqual({
      isAllDay: true,
      start: { dateTime: '2026-12-30T00:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2027-01-01T00:00:00', timeZone: 'Europe/Berlin' },
    });
  });
});

describe('graphText', () => {
  it('writes only the text the caller passed, and empty text to remove it', () => {
    expect(graphText({ title: 'Planning', location: '' })).toEqual({
      subject: 'Planning',
      location: { displayName: '' },
    });
  });
});

describe('allowsTeams', () => {
  it('needs Teams among the providers of the calendar', () => {
    const calendar = { id: 'cal-1', name: 'Calendar' };
    expect(
      [['teamsForBusiness'], ['unknown'], null].map((providers) =>
        allowsTeams({ ...calendar, allowedOnlineMeetingProviders: providers }),
      ),
    ).toEqual([true, false, false]);
  });
});

describe('notifiedAttendees', () => {
  it('leaves out the organizer', () => {
    expect(notifiedAttendees(meeting)).toEqual([
      'ann@example.com',
      'bob@example.com',
    ]);
  });
});

describe('changedAttendees', () => {
  it('keeps the other attendees with their type and adds the new ones', () => {
    expect(
      changedAttendees(meeting, ['Cy@Example.com'], ['BOB@example.com']),
    ).toEqual(
      Result.succeed({
        attendees: [
          {
            emailAddress: { address: 'ann@example.com', name: 'Ann' },
            type: 'optional',
          },
          { emailAddress: { address: 'Cy@Example.com' }, type: 'required' },
        ],
        added: ['Cy@Example.com'],
      }),
    );
  });

  it('refuses the organizer, a present attendee, and an absent one', () => {
    expect(
      [
        changedAttendees(meeting, ['me@example.com'], []),
        changedAttendees(meeting, ['ann@example.com'], []),
        changedAttendees(meeting, [], ['cy@example.com']),
      ].map((changed) => Result.isFailure(changed) && changed.failure),
    ).toEqual([
      'me@example.com is already the organizer or an attendee',
      'ann@example.com is already the organizer or an attendee',
      'cy@example.com is not an attendee',
    ]);
  });
});
