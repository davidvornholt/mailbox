import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  failsOnFakeDav,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import { createEvent, deleteEvent, updateEvent } from './calendar-write';
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
} from './calendar-write.fixture';
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
      createEvent(
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
    });
    expect(put?.url).toBe(`https://dav.example.com${value.href}`);
    expect(put?.headers.get('if-none-match')).toBe('*');
    expect(put?.headers.get('content-type')).toBe(
      'text/calendar; charset=utf-8',
    );
    expect(put?.body).toContain(`UID:${uid}`);
    expect(put?.body).not.toMatch(scheduling);
  });

  it('refuses a calendar the user may only read', async () => {
    const { error, requests } = await failsOnFakeDav(
      calendarRoutes,
      createEvent(
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
      updateEvent(davAccount, target(), { title: 'Planning, final' }, berlin),
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
      '--notify-attendees for an event without attendees',
      eventRoutes(icsOf(...single)),
      target({ notifyAttendees: true }),
      'EventChangeError',
    ],
  ])('refuses %s', async (_name, routes, wanted, tag) => {
    const { error, requests } = await failsOnFakeDav(
      routes,
      updateEvent(davAccount, wanted, { title: 'Renamed' }, berlin),
    );
    expect(error).toMatchObject({ _tag: tag });
    expect(writeRequests(requests)).toEqual([]);
  });

  it('renames a recurring event with --series', async () => {
    const { value } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...weeklySeries)),
      updateEvent(
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
      updateEvent(davAccount, target(), { title: 'Renamed' }, berlin),
    );
    expect(error._tag).toBe('DavConflictError');
  });
});

describe('deleteEvent', () => {
  it('deletes the version the caller read and asks the server not to notify anyone', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...single)),
      deleteEvent(davAccount, target(), berlin),
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
      deleteEvent(davAccount, target(), berlin),
    );
    expect(error._tag).toBe('EventHasAttendeesError');
    expect(writeRequests(requests)).toEqual([]);
  });
});
