import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import { AccountConfig } from '../../../shared/accounts/config';
import type { Dav } from '../../../shared/dav/dav';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  succeedsOnFakeDav,
} from '../../../shared/dav/dav-server.fixture';
import type { Graph } from '../../../shared/graph/graph';
import {
  graphAccount,
  onFakeGraph,
} from '../../../shared/graph/graph-server.fixture';
import {
  accountCalendars,
  accountEvent,
  accountEvents,
  calendarAccounts,
} from './calendar';
import { calendarRoutes } from './calendar-write.fixture';
import { berlin, icsOf, vevent, windowOf } from './ical.fixture';

// An account with calendars on a CalDAV server and in Outlook.
const both: Account = { ...davAccount, graph: graphAccount.graph };

const davEvent = icsOf(
  ...vevent(
    'UID:review@example.com',
    'DTSTAMP:20261001T000000Z',
    'SUMMARY:Review',
    'DTSTART:20261104T090000Z',
    'DTEND:20261104T100000Z',
  ),
);

const davRoutes = {
  ...calendarRoutes,
  'REPORT /calendars/me/work/': {
    body: multistatus(
      davResponse(
        '/calendars/me/work/review.ics',
        `<d:getetag>"r1"</d:getetag><c:calendar-data>${davEvent}</c:calendar-data>`,
      ),
    ),
  },
  'REPORT /calendars/me/shared/': { body: multistatus() },
  'GET /calendars/me/work/review.ics': {
    status: 200,
    body: davEvent,
    headers: { etag: '"r1"' },
  },
};

const graphEvent = {
  id: 'event-1',
  subject: 'Planning',
  start: { dateTime: '2026-11-03T13:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-03T14:00:00.0000000', timeZone: 'UTC' },
};

const graphRoutes = (...names: ReadonlyArray<string>) => ({
  '/me/calendars': {
    value: names.map((name, index) => ({ id: `cal-${index + 1}`, name })),
  },
  '/me/calendars/cal-1/calendarView': { value: [graphEvent] },
  '/me/events/event-1': graphEvent,
});

const week = windowOf('2026-11-02T23:00:00Z', '2026-11-09T23:00:00Z');

const onBoth = <A, E>(
  graphNames: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, Dav | Graph>,
) => {
  const graph = onFakeGraph(graphRoutes(...graphNames), effect);
  return { graphRequests: graph.requests, effect: graph.effect };
};

describe('accountCalendars', () => {
  it('lists the CalDAV calendars, then the Outlook ones', async () => {
    const { effect } = onBoth(['Calendar'], accountCalendars(both));
    const { value } = await succeedsOnFakeDav(davRoutes, effect);
    expect(value.map(({ href, name }) => `${name} ${href}`)).toEqual([
      'Work /calendars/me/work/',
      'Shared /calendars/me/shared/',
      'Calendar cal-1',
    ]);
  });
});

describe('accountEvents', () => {
  it('reads the events of both servers', async () => {
    const { effect } = onBoth(
      ['Calendar'],
      accountEvents(both, { window: week }, berlin),
    );
    const { value } = await succeedsOnFakeDav(davRoutes, effect);
    expect(
      value.events.map(({ event }) => `${event.calendar}: ${event.summary}`),
    ).toEqual(['Work: Review', 'Calendar: Planning']);
    expect(value.unreadable).toEqual([]);
  });

  it('reads only the calendar named', async () => {
    const { effect, graphRequests } = onBoth(
      ['Calendar'],
      accountEvents(both, { window: week, calendar: 'cal-1' }, berlin),
    );
    const { value, requests } = await succeedsOnFakeDav(davRoutes, effect);
    expect(value.events.map(({ event }) => event.href)).toEqual(['event-1']);
    expect(requests.filter(({ method }) => method === 'REPORT')).toEqual([]);
    expect(graphRequests).toHaveLength(2);
  });

  it('refuses a name that matches a calendar on both servers', async () => {
    const { effect } = onBoth(
      ['work'],
      accountEvents(both, { window: week, calendar: 'Work' }, berlin),
    );
    const { error } = await failsOnFakeDav(davRoutes, effect);
    expect(error).toMatchObject({
      _tag: 'CalendarNotFoundError',
      message:
        'me@example.com has several calendars that match "Work"; pass an exact href from "pim calendar list" instead',
    });
  });
});

describe('accountEvent', () => {
  it('reads a CalDAV href from the calendar server and an id from Outlook', async () => {
    const dav = onBoth(
      [],
      accountEvent(both, '/calendars/me/work/review.ics', berlin),
    );
    const outlook = onBoth([], accountEvent(both, 'event-1', berlin));
    expect(
      (await succeedsOnFakeDav(davRoutes, dav.effect)).value,
    ).toMatchObject({
      summary: 'Review',
      etag: '"r1"',
      ics: davEvent,
    });
    expect(dav.graphRequests).toEqual([]);
    const shown = (await succeedsOnFakeDav(davRoutes, outlook.effect)).value;
    expect(shown).toMatchObject({ summary: 'Planning', href: 'event-1' });
    expect(shown).not.toHaveProperty('ics');
  });

  it('needs a calendar server or Outlook', async () => {
    const { dav: _dav, ...neither } = davAccount;
    const { effect } = onBoth([], accountEvent(neither, 'event-1', berlin));
    expect((await failsOnFakeDav(davRoutes, effect)).error).toMatchObject({
      _tag: 'CalendarNotConfiguredError',
      message:
        'me@example.com has no calendars: its account config has neither a dav table with the server DAV url nor a graph table for Outlook',
    });
  });
});

describe('calendarAccounts', () => {
  const withAccounts = (accounts: ReadonlyArray<Account>, only?: string) =>
    Effect.runSync(
      Effect.result(
        calendarAccounts(only).pipe(
          Effect.provideService(
            AccountConfig,
            AccountConfig.of({
              accounts,
              emails: accounts.map(({ email }) => email),
              getAccount: () => Effect.die('pim reads every account'),
            }),
          ),
        ),
      ),
    );

  it('reads every account with a calendar server or Outlook', () => {
    const { dav: _dav, ...mailOnly } = {
      ...davAccount,
      email: 'mail@example.com',
    };
    const outlook = { ...graphAccount, email: 'outlook@example.com' };
    expect(withAccounts([mailOnly, davAccount, outlook])).toEqual(
      Result.succeed([davAccount, outlook]),
    );
  });

  it('explains how to add calendars', () => {
    const { dav: _dav, ...mailOnly } = davAccount;
    expect(withAccounts([mailOnly])).toMatchObject({
      failure: {
        _tag: 'CalendarNotConfiguredError',
        message:
          'No account has calendars: add a dav table with the server DAV url, or a graph table for Outlook, to an account in the account config',
      },
    });
  });
});
