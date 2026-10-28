import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  type RecordedRequest,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import { noScheduling, unfolded } from './calendar-write.fixture';
import { parseCalendar } from './event-fields';
import { berlin } from './ical.fixture';
import { unansweredCopy } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { describeInvitation } from './invitation-copies';
import { importChange } from './invitation-merge';
import { answerInvitation } from './invitation-reply';
import {
  accept,
  copies,
  copyHref,
  newResource,
  occurrenceEvent,
  routesWith,
  storedCopy,
  storedSeries,
  weekly,
} from './invitation-reply.fixture';

const answered = (accepted: string) => ({
  status: 200,
  headers: { etag: '"c2"' },
  body: accepted.replace(
    'ORGANIZER;CN=Boss',
    'ORGANIZER;CN=Boss;SCHEDULE-STATUS=1.2',
  ),
});

// The headers that ask the server to tell no one about a write.
const silent = (request: RecordedRequest | undefined) => ({
  scheduleReply: request?.headers.get('schedule-reply'),
  leftToCalendarApp: unfolded(request?.body)?.includes(
    'ORGANIZER;CN=Boss;SCHEDULE-AGENT=CLIENT',
  ),
});

describe('answerInvitation through the calendar server', () => {
  it('adds the meeting silently and then answers it, so the server sends one reply', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      routesWith(copies(), {
        'PUT /calendars/me/work/*': [
          { status: 201, headers: { etag: '"c1"' } },
          { status: 204, headers: { etag: '"c2"' } },
          { status: 204, headers: { etag: '"c3"' } },
        ],
        'GET /calendars/me/work/*': [
          {
            status: 200,
            headers: { etag: '"c2"' },
            body: unansweredCopy(received(), ['me@example.com']),
          },
          answered(storedCopy('ACCEPTED')),
        ],
      }),
      answerInvitation(davAccount, received(), accept, berlin),
    );
    const [create, restore, answer] = writeRequests(requests);
    expect(create?.url).toMatch(newResource);
    expect(create?.headers.get('if-none-match')).toBe('*');
    expect(silent(create)).toEqual({
      scheduleReply: 'F',
      leftToCalendarApp: true,
    });
    expect(unfolded(create?.body)).not.toContain('METHOD');
    expect(unfolded(create?.body)).toContain(
      'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
    );
    expect(restore?.url).toBe(create?.url ?? '');
    expect(restore?.headers.get('if-match')).toBe('"c1"');
    expect(silent(restore)).toEqual({
      scheduleReply: 'F',
      leftToCalendarApp: false,
    });
    expect(answer?.url).toBe(create?.url ?? '');
    expect(answer?.headers.get('if-match')).toBe('"c2"');
    expect(silent(answer)).toEqual({
      scheduleReply: null,
      leftToCalendarApp: false,
    });
    expect(unfolded(answer?.body)).toContain(
      'PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Me',
    );
    expect(answer?.body).not.toContain('SCHEDULE-FORCE-SEND');
    expect(value).toMatchObject({
      _tag: 'Answered',
      event: {
        etag: '"c2"',
        organizer: { email: 'boss@example.com', scheduleStatus: '1.2' },
      },
    });
  });

  it.each([
    ['NEEDS-ACTION', 'tentative', 'PARTSTAT=TENTATIVE;RSVP=TRUE;CN=Me'],
    // A calendar app held the answer, so the server has sent none yet.
    [
      'ACCEPTED;SCHEDULE-AGENT=CLIENT',
      'accepted',
      'PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Me',
    ],
  ] as const)(
    'answers a copy that holds %s with %s',
    async (stored, partstat, given) => {
      const { requests } = await succeedsOnFakeDav(
        routesWith(copies([copyHref, storedCopy(stored)]), {
          [`PUT ${copyHref}`]: { status: 204, headers: { etag: '"c2"' } },
          [`GET ${copyHref}`]: answered(storedCopy(partstat.toUpperCase())),
        }),
        answerInvitation(
          davAccount,
          received(),
          { ...accept, partstat },
          berlin,
        ),
      );
      const [answer, another] = writeRequests(requests);
      expect(another).toBeUndefined();
      expect(answer?.url).toEndWith(copyHref);
      expect(answer?.headers.get('if-match')).toBe('"c1"');
      expect(unfolded(answer?.body)).toContain(given);
      expect(answer?.body).not.toContain('SCHEDULE-AGENT');
      expect(answer?.body).not.toContain('SCHEDULE-FORCE-SEND');
    },
  );

  it('makes the server send the same answer again', async () => {
    const { requests } = await succeedsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('ACCEPTED')]), {
        [`PUT ${copyHref}`]: { status: 204, headers: { etag: '"c2"' } },
      }),
      answerInvitation(davAccount, received(), accept, berlin),
    );
    const [answer, another] = writeRequests(requests);
    expect(another).toBeUndefined();
    expect(unfolded(answer?.body)).toContain(
      'ORGANIZER;CN=Boss;SCHEDULE-FORCE-SEND=REPLY:mailto:boss@example.com',
    );
  });
});

describe('answerInvitation of a changed meeting', () => {
  it.each([
    [
      // The organizer moved the meeting and dropped an occurrence, which
      // resets the answer the calendar holds.
      'an updated meeting',
      received(
        invitationIcs(
          ...review(
            'SEQUENCE:1',
            weekly,
            'EXDATE;TZID=W. Europe Standard Time:20261111T100000',
          ),
        ).replaceAll('T100000', 'T090000'),
      ),
      storedSeries('ACCEPTED', weekly),
    ],
    [
      'one occurrence',
      received(invitationIcs(...occurrenceEvent('NEEDS-ACTION'))),
      storedSeries('NEEDS-ACTION', weekly),
    ],
  ])(
    'brings the copy up to date silently and then answers %s',
    async (_name, invitation, stored) => {
      const change = importChange(invitation, ['me@example.com'], {
        href: copyHref,
        object: Effect.runSync(parseCalendar(copyHref, stored)),
      });
      if (Result.isFailure(change) || change.success._tag !== 'Change') {
        throw new Error('The invitation should change the copy');
      }
      const imported = change.success.vcalendar.toString();
      const { requests } = await succeedsOnFakeDav(
        routesWith(copies([copyHref, stored]), {
          [`PUT ${copyHref}`]: [
            { status: 204, headers: { etag: '"u1"' } },
            { status: 204, headers: { etag: '"u2"' } },
            { status: 204, headers: { etag: '"c2"' } },
          ],
          [`GET ${copyHref}`]: {
            status: 200,
            headers: { etag: '"u2"' },
            body: imported,
          },
        }),
        answerInvitation(davAccount, invitation, accept, berlin),
      );
      const [update, restore, answer, another] = writeRequests(requests);
      expect(another).toBeUndefined();
      expect(update?.headers.get('if-match')).toBe('"c1"');
      expect(silent(update)).toEqual({
        scheduleReply: 'F',
        leftToCalendarApp: true,
      });
      expect(restore?.headers.get('if-match')).toBe('"u1"');
      expect(restore?.body).toBe(imported);
      expect(silent(restore).scheduleReply).toBe('F');
      expect(answer?.headers.get('if-match')).toBe('"u2"');
      expect(silent(answer).scheduleReply).toBeNull();
      const events = unfolded(answer?.body)?.split('BEGIN:VEVENT').slice(1);
      const accepted = events?.map((event) =>
        event.includes('PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Me'),
      );
      expect(accepted).toEqual(
        invitation.object.master.hasProperty('recurrence-id')
          ? [false, true]
          : [true],
      );
      expect(answer?.body).not.toContain('SCHEDULE-FORCE-SEND');
    },
  );

  it('tells the user when the server may have sent the answer', async () => {
    const { error } = await failsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('NEEDS-ACTION')]), {
        [`PUT ${copyHref}`]: { status: 503 },
      }),
      answerInvitation(davAccount, received(), accept, berlin),
    );
    expect(error).toMatchObject({ _tag: 'InvitationError' });
    expect(error.message).toContain('may have stored the answer');
  });
});

describe('answerInvitation by email', () => {
  const { dav: _dav, ...mailAccount } = davAccount;

  it.each([
    ['for an account without calendars', mailAccount, routesWith(copies())],
    [
      'when the server does not send answers',
      davAccount,
      { ...routesWith(copies()), 'OPTIONS /calendars/me/work/': noScheduling },
    ],
    [
      'when the account may only read its calendars',
      davAccount,
      {
        ...routesWith(copies()),
        'PROPFIND /calendars/me/': {
          body: multistatus(
            davResponse(
              '/calendars/me/shared/',
              '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>',
            ),
          ),
        },
      },
    ],
  ])('returns the reply %s', async (_name, account, routes) => {
    const { value, requests } = await succeedsOnFakeDav(
      routes,
      answerInvitation(account, received(), accept, berlin),
    );
    expect(value).toMatchObject({
      _tag: 'Reply',
      reply: {
        to: 'boss@example.com',
        subject: 'Accepted: Review',
        text: 'Me has accepted this invitation.\n',
      },
    });
    expect(writeRequests(requests)).toEqual([]);
  });

  it('returns the reply for an address the calendar server does not know', async () => {
    const alias = { ...davAccount, email: 'alias@example.com' };
    const { value, requests } = await succeedsOnFakeDav(
      routesWith(copies()),
      answerInvitation(
        alias,
        received(
          invitationIcs(...review()).replace(
            'mailto:me@example.com',
            'mailto:alias@example.com',
          ),
        ),
        accept,
        berlin,
      ),
    );
    expect(value).toMatchObject({ _tag: 'Reply' });
    expect(writeRequests(requests)).toEqual([]);
  });
});

describe('describeInvitation', () => {
  it('shows the meeting and the answer the calendar holds', async () => {
    const { value } = await succeedsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('TENTATIVE')])),
      describeInvitation(davAccount, received(), berlin),
    );
    expect(value).toMatchObject({
      method: 'request',
      sequence: 0,
      attendee: 'me@example.com',
      event: {
        summary: 'Review',
        start: '2026-11-04T10:00:00+01:00',
        organizer: { email: 'boss@example.com', name: 'Boss' },
      },
      copies: [
        {
          calendar: 'Work',
          href: copyHref,
          etag: '"c1"',
          partstat: 'tentative',
        },
      ],
    });
  });
});
