import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import {
  davResponse,
  discoveryRoutes,
  fakeDavServer,
  multistatus,
} from '../../../shared/dav/dav-server.fixture';
import { fetchCalendarObject, listCalendars, queryEvents } from './caldav';
import { windowOf } from './ical.fixture';

const calendarType =
  '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>';
const privileges = (...names: ReadonlyArray<string>) =>
  `<d:current-user-privilege-set>${names.map((name) => `<d:privilege><d:${name}/></d:privilege>`).join('')}</d:current-user-privilege-set>`;
const components = (...names: ReadonlyArray<string>) =>
  `<c:supported-calendar-component-set>${names.map((name) => `<c:comp name="${name}"/>`).join('')}</c:supported-calendar-component-set>`;

const home = multistatus(
  davResponse(
    '/calendars/me/',
    '<d:resourcetype><d:collection/></d:resourcetype>',
  ),
  davResponse(
    '/calendars/me/work/',
    `${calendarType}<d:displayname>Work</d:displayname><ical:calendar-color>#ff0000</ical:calendar-color>${components('VEVENT', 'VTODO')}${privileges('read', 'write')}`,
  ),
  davResponse(
    '/calendars/me/shared%20team/',
    `${calendarType}${privileges('read')}`,
  ),
  davResponse(
    '/calendars/me/tasks/',
    `${calendarType}<d:displayname>Tasks</d:displayname>${components('VTODO')}`,
  ),
  davResponse(
    '/calendars/me/inbox/',
    '<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>',
  ),
);

describe('listCalendars', () => {
  it('lists the event calendars in the calendar home', async () => {
    const { client, requests } = fakeDavServer({
      ...discoveryRoutes,
      'PROPFIND /calendars/me/': { body: home },
    });
    const calendars = await Effect.runPromise(listCalendars(client));
    expect(calendars).toEqual([
      {
        account: 'me@example.com',
        href: '/calendars/me/work/',
        name: 'Work',
        color: '#ff0000',
        writable: true,
      },
      {
        account: 'me@example.com',
        href: '/calendars/me/shared%20team/',
        name: 'shared team',
        writable: false,
      },
    ]);
    expect(requests.at(-1)?.depth).toBe('1');
  });

  it.each([
    [
      'a home that is itself a calendar',
      ['/calendars/me/work/'],
      {
        'PROPFIND /calendars/me/work/': {
          body: multistatus(
            davResponse('/calendars/me/work/', calendarType),
            davResponse('/calendars/me/work/a.ics', '<d:resourcetype/>'),
          ),
        },
      },
      ['/calendars/me/work/'],
    ],
    [
      'two homes',
      ['/calendars/me/', '/calendars/team/'],
      {
        'PROPFIND /calendars/me/': { body: home },
        'PROPFIND /calendars/team/': {
          body: multistatus(
            davResponse(
              '/calendars/team/',
              '<d:resourcetype><d:collection/></d:resourcetype>',
            ),
            davResponse('/calendars/team/plans/', calendarType),
          ),
        },
      },
      [
        '/calendars/me/work/',
        '/calendars/me/shared%20team/',
        '/calendars/team/plans/',
      ],
    ],
  ])('lists the calendars of %s', async (_, homes, routes, hrefs) => {
    const { client } = fakeDavServer({
      ...discoveryRoutes,
      'PROPFIND /principals/me/': {
        body: multistatus(
          davResponse(
            '/principals/me/',
            `<c:calendar-home-set>${homes.map((href) => `<d:href>${href}</d:href>`).join('')}</c:calendar-home-set>`,
          ),
        ),
      },
      ...routes,
    });
    const calendars = await Effect.runPromise(listCalendars(client));
    expect(calendars.map(({ href }) => href)).toEqual(hrefs);
  });

  it('reports a server without calendars', async () => {
    const { client } = fakeDavServer({
      ...discoveryRoutes,
      'PROPFIND /principals/me/': {
        body: multistatus(
          davResponse('/principals/me/', '<d:displayname>Me</d:displayname>'),
        ),
      },
    });
    const error = await Effect.runPromise(Effect.flip(listCalendars(client)));
    expect(error.message).toContain('offers no calendars');
  });
});

describe('queryEvents', () => {
  it('asks for the events around the window in UTC', async () => {
    const { client, requests } = fakeDavServer({
      'REPORT /calendars/me/work/': {
        body: multistatus(
          davResponse(
            '/calendars/me/work/a.ics',
            '<d:getetag>"a1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\nEND:VCALENDAR</c:calendar-data>',
          ),
          davResponse(
            '/calendars/me/work/b.ics',
            '<d:getetag>"b1"</d:getetag>',
          ),
          '<d:response><d:href>/calendars/me/work/c.ics</d:href><d:propstat><d:prop><d:getetag>"c1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 500 Internal Server Error</d:status></d:propstat></d:response>',
          '<d:response><d:href>/calendars/me/work/d.ics</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>',
        ),
      },
    });
    const resources = await Effect.runPromise(
      queryEvents(
        client,
        '/calendars/me/work/',
        windowOf('2026-10-26T23:00:00Z', '2026-11-02T23:00:00Z'),
      ),
    );
    expect(
      resources.map(
        Result.match({
          onSuccess: (resource) => resource,
          onFailure: (error) => `${error._tag}: ${error.message}`,
        }),
      ),
    ).toEqual([
      {
        href: '/calendars/me/work/a.ics',
        etag: '"a1"',
        // XML parsing turns the CRLF line breaks into LF.
        ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      },
      'CalendarDataError: The server did not return the event data of /calendars/me/work/b.ics',
      'CalendarDataError: The server did not return the event data of /calendars/me/work/c.ics (HTTP 500)',
      'CalendarDataError: The server did not return the event data of /calendars/me/work/d.ics (HTTP 403)',
    ]);
    expect(requests[0]?.depth).toBe('1');
    // Widened by 26 hours on each side: a server that reads a floating 23:30
    // on November 2 in UTC, or in any other zone, still returns it.
    expect(requests[0]?.body).toContain(
      '<c:time-range start="20261025T210000Z" end="20261104T010000Z"/>',
    );
  });
});

describe('fetchCalendarObject', () => {
  it('returns the event data with its ETag', async () => {
    const { client } = fakeDavServer({
      'GET /calendars/me/work/a.ics': {
        status: 200,
        body: 'BEGIN:VCALENDAR',
        headers: { etag: '"a2"' },
      },
    });
    expect(
      await Effect.runPromise(
        fetchCalendarObject(client, '/calendars/me/work/a.ics'),
      ),
    ).toEqual({
      href: '/calendars/me/work/a.ics',
      etag: '"a2"',
      ics: 'BEGIN:VCALENDAR',
    });
  });
});
