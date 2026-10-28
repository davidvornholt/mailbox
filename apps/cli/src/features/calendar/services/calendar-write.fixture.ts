import {
  davResponse,
  discoveryRoutes,
  type FakeRoute,
  multistatus,
} from '../../../shared/dav/dav-server.fixture';
import type { EventTarget } from './calendar-write';
import { vevent } from './ical.fixture';

export type Routes = Readonly<Record<string, FakeRoute>>;

const privileges = (name: string) =>
  `<d:current-user-privilege-set><d:privilege><d:${name}/></d:privilege></d:current-user-privilege-set>`;

export const calendarRoutes: Routes = {
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

// OPTIONS answers of a server that sends invitations itself, and of one that
// does not.
export const schedules = {
  status: 200,
  headers: { dav: '1, 3, calendar-access, calendar-auto-schedule' },
};
export const noScheduling = {
  status: 200,
  headers: { dav: '1, 3, calendar-access' },
};

// The text of a write, with folded lines joined again.
export const unfolded = (body: string | undefined) =>
  body?.replaceAll('\r\n ', '');

export const trip = {
  title: 'Trip',
  span: {
    _tag: 'Days',
    first: { year: 2026, month: 10, day: 30 },
    last: { year: 2026, month: 10, day: 31 },
  },
} as const;

export const href = '/calendars/me/work/m.ics';

export const single = vevent(
  'UID:m@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Planning',
  'DTSTART:20261028T090000Z',
  'DTEND:20261028T100000Z',
);

// The event at href, whose GET answers with these headers.
export const eventRoutes = (
  ics: string,
  headers: Readonly<Record<string, string>> = { etag: '"v1"' },
): Routes => ({
  ...discoveryRoutes,
  [`OPTIONS ${href}`]: schedules,
  [`GET ${href}`]: { status: 200, body: ics, headers },
  [`PUT ${href}`]: { status: 204, headers: { etag: '"v2"' } },
  [`DELETE ${href}`]: { status: 204 },
});

export const target = (changes: Partial<EventTarget> = {}): EventTarget => ({
  href,
  etag: '"v1"',
  series: false,
  notifyAttendees: false,
  ...changes,
});

export const meeting = vevent(
  'UID:m@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Planning',
  'DTSTART:20261028T090000Z',
  'DTEND:20261028T100000Z',
  'ORGANIZER:mailto:me@example.com',
  'ATTENDEE:mailto:me@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ana@example.com',
);

export const invitation = vevent(
  'UID:i@example.com',
  'DTSTAMP:20261001T000000Z',
  'SUMMARY:Review',
  'DTSTART:20261028T090000Z',
  'DTEND:20261028T100000Z',
  'ORGANIZER:mailto:boss@example.com',
  'ATTENDEE:mailto:me@example.com',
);
