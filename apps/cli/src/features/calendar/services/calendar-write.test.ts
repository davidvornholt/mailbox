import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  davResponse,
  discoveryRoutes,
  type FakeReply,
  failsOnFakeDav,
  multistatus,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import {
  createEvent,
  deleteEvent,
  type EventTarget,
  updateEvent,
} from './calendar-write';
import { berlin, icsOf, vevent, weeklySeries } from './ical.fixture';

type Routes = Readonly<Record<string, FakeReply>>;

const privileges = (name: string) =>
  `<d:current-user-privilege-set><d:privilege><d:${name}/></d:privilege></d:current-user-privilege-set>`;

const calendarRoutes: Routes = {
  ...discoveryRoutes,
  'PROPFIND /calendars/me/': {
    body: multistatus(
      davResponse(
        '/calendars/me/work/',
        `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname>${privileges('all')}`,
      ),
      davResponse(
        '/calendars/me/shared/',
        `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Shared</d:displayname>${privileges('read')}`,
      ),
    ),
  },
};

const newHref = /^\/calendars\/me\/work\/(?<uid>[0-9a-f-]{36})\.ics$/u;
const scheduling = /ORGANIZER|ATTENDEE/u;

const trip = {
  title: 'Trip',
  span: {
    _tag: 'Days',
    first: { year: 2026, month: 10, day: 30 },
    last: { year: 2026, month: 10, day: 31 },
  },
} as const;

describe('createEvent', () => {
  it('stores a new event that invites no one', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      {
        ...calendarRoutes,
        'PUT /calendars/me/work/*': { status: 201, headers: { etag: '"e1"' } },
      },
      createEvent(davAccount, { calendar: 'Work', ...trip }, berlin),
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
      createEvent(davAccount, { calendar: 'Shared', ...trip }, berlin),
    );
    expect(error._tag).toBe('ReadOnlyCalendarError');
    expect(writeRequests(requests)).toEqual([]);
  });
});

const href = '/calendars/me/work/m.ics';

const single = vevent(
  'UID:m@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Planning',
  'DTSTART:20261028T090000Z',
  'DTEND:20261028T100000Z',
);

// The event at href, whose GET answers with these headers.
const eventRoutes = (
  ics: string,
  headers: Readonly<Record<string, string>> = { etag: '"v1"' },
): Routes => ({
  [`GET ${href}`]: { status: 200, body: ics, headers },
  [`PUT ${href}`]: { status: 204, headers: { etag: '"v2"' } },
  [`DELETE ${href}`]: { status: 204 },
});

const target = (changes: Partial<EventTarget> = {}): EventTarget => ({
  href,
  etag: '"v1"',
  series: false,
  ...changes,
});

const meeting = vevent(
  'UID:m@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Planning',
  'DTSTART:20261028T090000Z',
  'DTEND:20261028T100000Z',
  'ORGANIZER:mailto:me@example.com',
  'ATTENDEE:mailto:me@example.com',
  'ATTENDEE:mailto:ana@example.com',
);

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
