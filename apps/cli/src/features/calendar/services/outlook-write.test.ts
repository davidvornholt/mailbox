import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import {
  fakeGraph,
  GraphReply,
  type GraphRequest,
  type GraphRoute,
} from '../../../shared/graph/graph-server.fixture';
import { berlin } from './ical.fixture';
import {
  createOutlookEvent,
  deleteOutlookEvent,
  type OutlookEventRequest,
  type OutlookTarget,
  updateOutlookEvent,
} from './outlook-write';

const conflictCode = 412;
const noContentCode = 204;

const calendar = {
  id: 'cal-1',
  name: 'Calendar',
  canEdit: true,
  allowedOnlineMeetingProviders: ['teamsForBusiness'],
};

const utc = (time: string) => ({ dateTime: time, timeZone: 'UTC' });

const stored = {
  '@odata.etag': 'W/"1"',
  id: 'event-1',
  subject: 'Planning',
  start: utc('2026-11-17T13:00:00.0000000'),
  end: utc('2026-11-17T14:00:00.0000000'),
  isAllDay: false,
  type: 'singleInstance',
  isOrganizer: true,
  organizer: { emailAddress: { address: 'me@example.com' } },
  attendees: [],
};

const meeting = {
  ...stored,
  attendees: [
    {
      emailAddress: { address: 'ann@example.com' },
      type: 'required',
      status: { response: 'accepted' },
    },
  ],
};

// A series without attendees, one of whose occurrences is a meeting.
const seriesWithMeeting = {
  ...stored,
  type: 'seriesMaster',
  exceptionOccurrences: [{ ...meeting, id: 'event-2', type: 'exception' }],
};

const request: OutlookEventRequest = {
  title: 'Planning',
  span: {
    _tag: 'Times',
    startMs: Date.parse('2026-11-17T13:00:00Z'),
    endMs: Date.parse('2026-11-17T14:00:00Z'),
  },
  attendees: [],
  notifyAttendees: false,
  zone: berlin,
  teams: false,
};

const target = (fields: Partial<OutlookTarget> = {}): OutlookTarget => ({
  href: 'event-1',
  etag: 'W/"1"',
  series: false,
  notifyAttendees: false,
  ...fields,
});

const run = async <A, E>(
  routes: Readonly<Record<string, GraphRoute>>,
  write: (
    client: ReturnType<typeof fakeGraph>['client'],
  ) => Effect.Effect<A, E>,
) => {
  const { client, requests } = fakeGraph(routes);
  const result = await Effect.runPromise(Effect.result(write(client)));
  return { result, requests };
};

const writes = (requests: ReadonlyArray<GraphRequest>) =>
  requests.filter(({ method }) => method !== undefined);

describe('createOutlookEvent', () => {
  it('writes the times in the zone and invites no one', async () => {
    const { result, requests } = await run(
      {
        'POST /me/calendars/cal-1/events': stored,
        '/me/events/event-1': stored,
      },
      (client) => createOutlookEvent(client, calendar, request, berlin),
    );
    expect(result).toMatchObject({
      success: {
        href: 'event-1',
        etag: 'W/"1"',
        start: '2026-11-17T14:00:00+01:00',
      },
    });
    expect(writes(requests)).toEqual([
      {
        url: 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events',
        prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
        method: 'POST',
        body: {
          subject: 'Planning',
          isAllDay: false,
          start: { dateTime: '2026-11-17T14:00:00', timeZone: 'Europe/Berlin' },
          end: { dateTime: '2026-11-17T15:00:00', timeZone: 'Europe/Berlin' },
        },
      },
    ]);
  });

  it('adds a Teams meeting and the attendees the user asked to invite', async () => {
    const { requests } = await run(
      {
        'POST /me/calendars/cal-1/events': meeting,
        '/me/events/event-1': meeting,
      },
      (client) =>
        createOutlookEvent(
          client,
          calendar,
          {
            ...request,
            attendees: ['ann@example.com'],
            notifyAttendees: true,
            teams: true,
          },
          berlin,
        ),
    );
    expect(writes(requests)[0]?.body).toMatchObject({
      attendees: [
        { emailAddress: { address: 'ann@example.com' }, type: 'required' },
      ],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
  });

  it('writes nothing it was not allowed to', async () => {
    const refusals = await Promise.all(
      [
        createOutlookEvent(
          fakeGraph({}).client,
          calendar,
          { ...request, attendees: ['ann@example.com'] },
          berlin,
        ),
        createOutlookEvent(
          fakeGraph({}).client,
          { ...calendar, allowedOnlineMeetingProviders: ['unknown'] },
          { ...request, teams: true },
          berlin,
        ),
        createOutlookEvent(
          fakeGraph({}).client,
          { ...calendar, canEdit: false },
          request,
          berlin,
        ),
      ].map((write) => Effect.runPromise(Effect.flip(write))),
    );
    expect(refusals.map(({ _tag }) => _tag)).toEqual([
      'EventHasAttendeesError',
      'EventChangeError',
      'ReadOnlyCalendarError',
    ]);
  });
});

const changes = { zone: berlin, teams: false };

describe('updateOutlookEvent', () => {
  it('changes the version the caller read', async () => {
    const { result, requests } = await run(
      {
        '/me/events/event-1': stored,
        'PATCH /me/events/event-1': { ...stored, '@odata.etag': 'W/"2"' },
      },
      (client) =>
        updateOutlookEvent(
          client,
          target(),
          {
            ...changes,
            title: 'Planning, final',
            location: '',
            start: { _tag: 'Instant', ms: Date.parse('2026-11-17T15:00:00Z') },
          },
          berlin,
        ),
    );
    expect(result._tag).toBe('Success');
    expect(writes(requests)).toMatchObject([
      {
        method: 'PATCH',
        ifMatch: 'W/"1"',
        body: {
          subject: 'Planning, final',
          location: { displayName: '' },
          isAllDay: false,
          start: { dateTime: '2026-11-17T16:00:00', timeZone: 'Europe/Berlin' },
          end: { dateTime: '2026-11-17T17:00:00', timeZone: 'Europe/Berlin' },
        },
      },
    ]);
  });

  it('writes nothing when the event changed or a write would email someone', async () => {
    const cases: ReadonlyArray<readonly [GraphRoute, OutlookTarget]> = [
      [stored, target({ etag: 'W/"0"' })],
      [meeting, target()],
      [{ ...meeting, isOrganizer: false }, target({ notifyAttendees: true })],
      [{ ...stored, type: 'seriesMaster' }, target()],
      [seriesWithMeeting, target({ series: true })],
      [{ ...stored, type: 'seriesMaster' }, target({ series: true })],
    ];
    const refusals = await Promise.all(
      cases.map(([event, refused]) =>
        run({ '/me/events/event-1': event }, (client) =>
          Effect.flip(
            updateOutlookEvent(
              client,
              refused,
              { ...changes, title: 'Planning, final' },
              berlin,
            ),
          ),
        ),
      ),
    );
    expect(
      refusals.map(({ result, requests }) => [
        result._tag === 'Success' && result.success._tag,
        writes(requests),
      ]),
    ).toEqual([
      ['GraphConflictError', []],
      ['EventHasAttendeesError', []],
      ['EventHasAttendeesError', []],
      ['EventChangeError', []],
      ['EventHasAttendeesError', []],
      ['CalendarDataError', []],
    ]);
  });
});

describe('updateOutlookEvent on a meeting', () => {
  it('asks before telling a new attendee', async () => {
    const { result, requests } = await run(
      { '/me/events/event-1': stored },
      (client) =>
        Effect.flip(
          updateOutlookEvent(
            client,
            target(),
            { ...changes, addAttendees: ['ann@example.com'] },
            berlin,
          ),
        ),
    );
    expect(result).toMatchObject({
      success: {
        _tag: 'EventHasAttendeesError',
        message:
          'This makes Microsoft email ann@example.com an update. Pass --notify-attendees only if the user asked to tell them',
      },
    });
    expect(writes(requests)).toEqual([]);
  });

  it('adds Teams only where the calendar offers it', async () => {
    const { result, requests } = await run(
      {
        '/me/events/event-1': stored,
        '/me/events/event-1/calendar': {
          ...calendar,
          allowedOnlineMeetingProviders: ['unknown'],
        },
      },
      (client) =>
        Effect.flip(
          updateOutlookEvent(
            client,
            target(),
            { ...changes, teams: true },
            berlin,
          ),
        ),
    );
    expect(result).toMatchObject({ success: { _tag: 'EventChangeError' } });
    expect(writes(requests)).toEqual([]);
  });

  it('reports a change Microsoft Graph made in between', async () => {
    const { result } = await run(
      {
        '/me/events/event-1': stored,
        'PATCH /me/events/event-1': new GraphReply(conflictCode, {
          error: { code: 'ErrorIrresolvableConflict' },
        }),
      },
      (client) =>
        Effect.flip(
          updateOutlookEvent(
            client,
            target(),
            { ...changes, title: 'Planning, final' },
            berlin,
          ),
        ),
    );
    expect(result).toMatchObject({ success: { _tag: 'GraphConflictError' } });
  });
});

describe('deleteOutlookEvent', () => {
  it('deletes an event without attendees and prints it', async () => {
    const { result, requests } = await run(
      {
        '/me/events/event-1': stored,
        'DELETE /me/events/event-1': new GraphReply(noContentCode),
      },
      (client) => deleteOutlookEvent(client, target(), berlin),
    );
    expect(result).toMatchObject({ success: { href: 'event-1' } });
    expect(writes(requests)).toMatchObject([{ method: 'DELETE' }]);
  });

  it('deletes no meeting it was not allowed to', async () => {
    const cases: ReadonlyArray<readonly [GraphRoute, OutlookTarget]> = [
      [meeting, target()],
      [{ ...meeting, isOrganizer: false }, target({ notifyAttendees: true })],
      [seriesWithMeeting, target({ series: true })],
      [{ ...stored, type: 'seriesMaster' }, target({ series: true })],
    ];
    const refusals = await Promise.all(
      cases.map(([event, refused]) =>
        run({ '/me/events/event-1': event }, (client) =>
          Effect.flip(deleteOutlookEvent(client, refused, berlin)),
        ),
      ),
    );
    expect(
      refusals.map(({ result, requests }) => [
        result._tag === 'Success' && result.success._tag,
        writes(requests),
      ]),
    ).toEqual([
      ['EventHasAttendeesError', []],
      ['EventHasAttendeesError', []],
      ['EventHasAttendeesError', []],
      ['CalendarDataError', []],
    ]);
  });
});
