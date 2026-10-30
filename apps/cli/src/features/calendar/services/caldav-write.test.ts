import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  failsOnFakeDav,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import {
  createCalDavEvent,
  deleteCalDavEvent,
  updateCalDavEvent,
} from './caldav-write';
import {
  calendarRoutes,
  eventRoutes,
  href,
  invitation,
  meeting,
  noScheduling,
  single,
  target,
  trip,
  unfolded,
} from './caldav-write.fixture';
import { berlin, icsOf, weeklySeries } from './ical.fixture';

const newHref = /^\/calendars\/me\/work\/(?<uid>[0-9a-f-]{36})\.ics$/u;
const scheduling = /ORGANIZER|ATTENDEE/u;

describe('createEvent', () => {
  it('stores a new event that invites no one', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      {
        ...calendarRoutes,
        'PUT /calendars/me/work/*': { status: 201, headers: { etag: '"e1"' } },
      },
      createCalDavEvent(
        davAccount,
        { calendar: 'Work', ...trip, attendees: [], notifyAttendees: false },
        berlin,
      ),
    );
    const [put] = writeRequests(requests);
    const { uid } = newHref.exec(value.href)?.groups ?? {};
    expect(value).toEqual({
      account: 'me@example.com',
      href: expect.stringMatching(newHref),
      etag: '"e1"',
      uid: uid ?? 'no uid in the href',
      summary: 'Trip',
      start: '2026-10-30',
      end: '2026-10-31',
      allDay: true,
      attendees: [],
      reminders: [],
    });
    expect(put?.url).toBe(`https://dav.example.com${value.href}`);
    expect(put?.headers.get('if-none-match')).toBe('*');
    expect(put?.headers.get('content-type')).toBe(
      'text/calendar; charset=utf-8',
    );
    expect(put?.body).toContain(`UID:${uid}`);
    expect(put?.body).not.toMatch(scheduling);
  });

  it('writes the reminders of a new event', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      {
        ...calendarRoutes,
        'PUT /calendars/me/work/*': { status: 201, headers: { etag: '"e1"' } },
      },
      createCalDavEvent(
        davAccount,
        {
          calendar: 'Work',
          ...trip,
          reminders: [
            { _tag: 'Relative', days: 0, seconds: -64_800, related: 'start' },
          ],
          attendees: [],
          notifyAttendees: false,
        },
        berlin,
      ),
    );
    expect(value.reminders).toEqual([{ when: '18h before start' }]);
    const [put] = writeRequests(requests);
    expect(unfolded(put?.body)).toContain(
      'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT18H\r\nDESCRIPTION:Trip\r\nEND:VALARM',
    );
  });

  it('refuses a calendar the user may only read', async () => {
    const { error, requests } = await failsOnFakeDav(
      calendarRoutes,
      createCalDavEvent(
        davAccount,
        { calendar: 'Shared', ...trip, attendees: [], notifyAttendees: false },
        berlin,
      ),
    );
    expect(error._tag).toBe('ReadOnlyCalendarError');
    expect(writeRequests(requests)).toEqual([]);
  });
});

describe('updateEvent', () => {
  it('changes the version the caller read', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...single)),
      updateCalDavEvent(
        davAccount,
        target(),
        { title: 'Planning, final' },
        berlin,
      ),
    );
    expect(value).toMatchObject({ etag: '"v2"', summary: 'Planning, final' });
    const [put] = writeRequests(requests);
    expect(put?.method).toBe('PUT');
    expect(put?.headers.get('if-match')).toBe('"v1"');
    expect(put?.body).toContain('SUMMARY:Planning\\, final');
  });

  it.each([
    [
      'an event that changed since it was read',
      eventRoutes(icsOf(...single), { etag: '"v9"' }),
      target(),
      'DavConflictError',
    ],
    [
      'an event the server gives no etag for',
      eventRoutes(icsOf(...single), {}),
      target(),
      'EventChangeError',
    ],
    [
      'a meeting with guests',
      eventRoutes(icsOf(...meeting)),
      target({ series: true }),
      'EventHasAttendeesError',
    ],
    [
      'a recurring event without --series',
      eventRoutes(icsOf(...weeklySeries)),
      target(),
      'EventChangeError',
    ],
    [
      'a meeting someone else organizes',
      eventRoutes(icsOf(...invitation)),
      target({ notifyAttendees: true }),
      'EventHasAttendeesError',
    ],
    [
      'a meeting on a server that does not send updates',
      { ...eventRoutes(icsOf(...meeting)), [`OPTIONS ${href}`]: noScheduling },
      target({ notifyAttendees: true }),
      'SchedulingUnsupportedError',
    ],
    [
      'a meeting with an attendee the server does not email',
      eventRoutes(
        icsOf(
          ...meeting.map((line) =>
            line.replace('ATTENDEE;', 'ATTENDEE;SCHEDULE-AGENT=CLIENT;'),
          ),
        ),
      ),
      target({ notifyAttendees: true }),
      'SchedulingUnsupportedError',
    ],
    [
      '--notify-attendees for an event without attendees',
      eventRoutes(icsOf(...single)),
      target({ notifyAttendees: true }),
      'EventChangeError',
    ],
  ])('refuses %s', async (_name, routes, wanted, tag) => {
    const { error, requests } = await failsOnFakeDav(
      routes,
      updateCalDavEvent(davAccount, wanted, { title: 'Renamed' }, berlin),
    );
    expect(error).toMatchObject({ _tag: tag });
    expect(writeRequests(requests)).toEqual([]);
  });

  it('renames a recurring event with --series', async () => {
    const { value } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...weeklySeries)),
      updateCalDavEvent(
        davAccount,
        target({ series: true }),
        { title: 'Sync' },
        berlin,
      ),
    );
    expect(value.summary).toBe('Sync');
  });

  it('reports a change the server refused for its version', async () => {
    const { error } = await failsOnFakeDav(
      {
        ...eventRoutes(icsOf(...single)),
        [`PUT ${href}`]: { status: 412 },
      },
      updateCalDavEvent(davAccount, target(), { title: 'Renamed' }, berlin),
    );
    expect(error._tag).toBe('DavConflictError');
  });
});

describe('updateEvent with reminders', () => {
  it('replaces the reminders of an event', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...single)),
      updateCalDavEvent(
        davAccount,
        target(),
        {
          reminders: [
            { _tag: 'Relative', days: 0, seconds: -900, related: 'start' },
          ],
        },
        berlin,
      ),
    );
    expect(value.reminders).toEqual([{ when: '15m before start' }]);
    const [put] = writeRequests(requests);
    expect(put?.headers.get('if-match')).toBe('"v1"');
    expect(unfolded(put?.body)).toContain('TRIGGER:-PT15M');
  });

  // A server may email the attendees about any change the organizer makes,
  // and an attendee's change may reach the organizer.
  it.each([
    ['without --notify-attendees', meeting, target()],
    ['someone else organizes', invitation, target({ notifyAttendees: true })],
  ])(
    'refuses to change only the reminders of a meeting %s',
    async (_name, event, wanted) => {
      const { error, requests } = await failsOnFakeDav(
        eventRoutes(icsOf(...event)),
        updateCalDavEvent(davAccount, wanted, { reminders: [] }, berlin),
      );
      expect(error._tag).toBe('EventHasAttendeesError');
      expect(writeRequests(requests)).toEqual([]);
    },
  );
});

describe('updateEvent on a server that changes the event', () => {
  it('reads back an event the server changed as it stored it', async () => {
    const { value } = await succeedsOnFakeDav(
      {
        ...eventRoutes(icsOf(...single)),
        [`GET ${href}`]: [
          { status: 200, body: icsOf(...single), headers: { etag: '"v1"' } },
          {
            status: 200,
            body: icsOf(...single).replace('SUMMARY:Planning', 'SUMMARY:Kept'),
            headers: { etag: '"v3"' },
          },
        ],
        [`PUT ${href}`]: { status: 204 },
      },
      updateCalDavEvent(davAccount, target(), { title: 'Renamed' }, berlin),
    );
    expect(value).toMatchObject({ etag: '"v3"', summary: 'Kept' });
  });
});

describe('deleteEvent', () => {
  it('deletes the version the caller read and asks the server not to notify anyone', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...single)),
      deleteCalDavEvent(davAccount, target(), berlin),
    );
    expect(value).toMatchObject({ href, summary: 'Planning' });
    expect(value).not.toHaveProperty('etag');
    const [deletion] = writeRequests(requests);
    expect(deletion?.method).toBe('DELETE');
    expect(deletion?.headers.get('if-match')).toBe('"v1"');
    expect(deletion?.headers.get('schedule-reply')).toBe('F');
  });

  it('refuses a meeting with guests', async () => {
    const { error, requests } = await failsOnFakeDav(
      eventRoutes(icsOf(...meeting)),
      deleteCalDavEvent(davAccount, target(), berlin),
    );
    expect(error._tag).toBe('EventHasAttendeesError');
    expect(writeRequests(requests)).toEqual([]);
  });
});
