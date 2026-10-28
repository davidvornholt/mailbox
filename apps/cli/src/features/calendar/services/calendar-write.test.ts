import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import { Dav } from '../../../shared/dav/dav';
import {
  davResponse,
  discoveryRoutes,
  type FakeReply,
  fakeDavServer,
  multistatus,
  type RecordedRequest,
} from '../../../shared/dav/dav-server.fixture';
import {
  createEvent,
  deleteEvent,
  type EventTarget,
  updateEvent,
} from './calendar-write';
import { berlin, icsOf, vevent, weeklySeries } from './ical.fixture';

const account: Account = {
  email: 'me@example.com',
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
  auth: 'password',
  dav: { url: 'https://dav.example.com/', user: 'me-dav' },
};

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

const provided = <A, E>(routes: Routes, effect: Effect.Effect<A, E, Dav>) => {
  const { client, requests } = fakeDavServer(routes);
  const dav = Dav.of({
    client: () => Effect.succeed(client),
    clientWith: () => Effect.succeed(client),
  });
  return { requests, effect: effect.pipe(Effect.provideService(Dav, dav)) };
};

const succeeds = async <A, E>(
  routes: Routes,
  effect: Effect.Effect<A, E, Dav>,
) => {
  const run = provided(routes, effect);
  return { value: await Effect.runPromise(run.effect), requests: run.requests };
};

const fails = async <A, E>(
  routes: Routes,
  effect: Effect.Effect<A, E, Dav>,
) => {
  const run = provided(routes, effect);
  return {
    error: await Effect.runPromise(Effect.flip(run.effect)),
    requests: run.requests,
  };
};

const writes = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.filter(({ method }) => method === 'PUT' || method === 'DELETE');

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
    const { value, requests } = await succeeds(
      {
        ...calendarRoutes,
        'PUT /calendars/me/work/*': { status: 201, headers: { etag: '"e1"' } },
      },
      createEvent(account, { calendar: 'Work', ...trip }, berlin),
    );
    const [put] = writes(requests);
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
    const { error, requests } = await fails(
      calendarRoutes,
      createEvent(account, { calendar: 'Shared', ...trip }, berlin),
    );
    expect(error._tag).toBe('ReadOnlyCalendarError');
    expect(writes(requests)).toEqual([]);
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
    const { value, requests } = await succeeds(
      eventRoutes(icsOf(...single)),
      updateEvent(account, target(), { title: 'Planning, final' }, berlin),
    );
    expect(value).toMatchObject({ etag: '"v2"', summary: 'Planning, final' });
    const [put] = writes(requests);
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
    const { error, requests } = await fails(
      routes,
      updateEvent(account, wanted, { title: 'Renamed' }, berlin),
    );
    expect(error).toMatchObject({ _tag: tag });
    expect(writes(requests)).toEqual([]);
  });

  it('renames a recurring event with --series', async () => {
    const { value } = await succeeds(
      eventRoutes(icsOf(...weeklySeries)),
      updateEvent(account, target({ series: true }), { title: 'Sync' }, berlin),
    );
    expect(value.summary).toBe('Sync');
  });

  it('reports a change the server refused for its version', async () => {
    const { error } = await fails(
      {
        ...eventRoutes(icsOf(...single)),
        [`PUT ${href}`]: { status: 412 },
      },
      updateEvent(account, target(), { title: 'Renamed' }, berlin),
    );
    expect(error._tag).toBe('DavConflictError');
  });
});

describe('deleteEvent', () => {
  it('deletes the version the caller read and asks the server not to notify anyone', async () => {
    const { value, requests } = await succeeds(
      eventRoutes(icsOf(...single)),
      deleteEvent(account, target(), berlin),
    );
    expect(value).toMatchObject({ href, summary: 'Planning' });
    expect(value).not.toHaveProperty('etag');
    const [deletion] = writes(requests);
    expect(deletion?.method).toBe('DELETE');
    expect(deletion?.headers.get('if-match')).toBe('"v1"');
    expect(deletion?.headers.get('schedule-reply')).toBe('F');
  });

  it('refuses a meeting with guests', async () => {
    const { error, requests } = await fails(
      eventRoutes(icsOf(...meeting)),
      deleteEvent(account, target(), berlin),
    );
    expect(error._tag).toBe('EventHasAttendeesError');
    expect(writes(requests)).toEqual([]);
  });
});
