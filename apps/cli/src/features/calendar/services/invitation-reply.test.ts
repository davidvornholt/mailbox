import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import {
  calendarRoutes,
  noScheduling,
  type Routes,
  schedules,
  unfolded,
} from './calendar-write.fixture';
import { berlin, icsOf, vevent } from './ical.fixture';
import { unansweredCopy } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { describeInvitation } from './invitation-copies';
import { answerInvitation } from './invitation-reply';

const copyHref = '/calendars/me/work/copy.ics';
const newResource = /\/calendars\/me\/work\/[\w-]+\.ics$/u;

// The meeting as the user's calendar stores it, with their answer.
const storedCopy = (partstat: string, ...extra: ReadonlyArray<string>) =>
  icsOf(...review('SEQUENCE:0'), ...extra).replace(
    'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
    `PARTSTAT=${partstat};RSVP=TRUE;CN=Me`,
  );

const copies = (...stored: ReadonlyArray<readonly [string, string]>) => ({
  body: multistatus(
    ...stored.map(([at, ics]) =>
      davResponse(
        at,
        `<d:getetag>"c1"</d:getetag><c:calendar-data>${ics}</c:calendar-data>`,
      ),
    ),
  ),
});

const routesWith = (report: Routes[string], more: Routes = {}): Routes => ({
  ...calendarRoutes,
  'OPTIONS /calendars/me/work/': schedules,
  'REPORT /calendars/me/work/': report,
  ...more,
});

const answered = (accepted: string) => ({
  status: 200,
  headers: { etag: '"c2"' },
  body: accepted.replace(
    'ORGANIZER;CN=Boss',
    'ORGANIZER;CN=Boss;SCHEDULE-STATUS=1.2',
  ),
});

const accept = { partstat: 'accepted', notifyOrganizer: true } as const;

describe('answerInvitation through the calendar server', () => {
  it('adds the meeting unanswered and then answers it, so the server sends one reply', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      routesWith(copies(), {
        'PUT /calendars/me/work/*': [
          { status: 201, headers: { etag: '"c1"' } },
          { status: 204, headers: { etag: '"c2"' } },
        ],
        'GET /calendars/me/work/*': [
          {
            status: 200,
            headers: { etag: '"c1"' },
            body: unansweredCopy(received(), 'me@example.com'),
          },
          answered(storedCopy('ACCEPTED')),
        ],
      }),
      answerInvitation(davAccount, received(), accept, berlin),
    );
    const [create, answer] = writeRequests(requests);
    expect(create?.url).toMatch(newResource);
    expect(create?.headers.get('if-none-match')).toBe('*');
    expect(unfolded(create?.body)).not.toContain('METHOD');
    expect(unfolded(create?.body)).toContain(
      'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
    );
    expect(answer?.url).toBe(create?.url ?? '');
    expect(answer?.headers.get('if-match')).toBe('"c1"');
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

  it('answers the meeting where the calendar already holds it', async () => {
    const { requests } = await succeedsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('NEEDS-ACTION')]), {
        [`PUT ${copyHref}`]: { status: 204, headers: { etag: '"c2"' } },
        [`GET ${copyHref}`]: answered(storedCopy('TENTATIVE')),
      }),
      answerInvitation(
        davAccount,
        received(),
        { ...accept, partstat: 'tentative' },
        berlin,
      ),
    );
    const [answer, another] = writeRequests(requests);
    expect(another).toBeUndefined();
    expect(answer?.url).toEndWith(copyHref);
    expect(answer?.headers.get('if-match')).toBe('"c1"');
    expect(unfolded(answer?.body)).toContain(
      'PARTSTAT=TENTATIVE;RSVP=TRUE;CN=Me',
    );
    expect(answer?.body).not.toContain('SCHEDULE-FORCE-SEND');
  });

  it.each([
    ['the same answer again', received()],
    [
      // The organizer reset the answer when they changed the meeting, while
      // the calendar still holds the old answer.
      'an updated meeting',
      received(
        invitationIcs(...review('SEQUENCE:1')).replace('T100000', 'T090000'),
      ),
    ],
  ])('makes the server send %s', async (_name, invitation) => {
    const { requests } = await succeedsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('ACCEPTED')]), {
        [`PUT ${copyHref}`]: { status: 204, headers: { etag: '"c2"' } },
      }),
      answerInvitation(davAccount, invitation, accept, berlin),
    );
    const [answer] = writeRequests(requests);
    const ics = unfolded(answer?.body);
    expect(ics).toContain(
      'ORGANIZER;CN=Boss;SCHEDULE-FORCE-SEND=REPLY:mailto:boss@example.com',
    );
    expect(ics).toContain(`SEQUENCE:${invitation.sequence}`);
    expect(ics).toContain(
      `DTSTART;TZID=W. Europe Standard Time:${invitation.sequence === 0 ? '20261104T100000' : '20261104T090000'}`,
    );
  });
});

describe('answerInvitation refusals', () => {
  it.each([
    [
      'without --notify-organizer',
      copies(),
      { ...accept, notifyOrganizer: false },
      'EventHasAttendeesError',
    ],
    [
      'when the meeting is in two calendars',
      copies(
        [copyHref, storedCopy('NEEDS-ACTION')],
        ['/calendars/me/work/again.ics', storedCopy('NEEDS-ACTION')],
      ),
      accept,
      'InvitationError',
    ],
    [
      'to resend an answer for a meeting with changed occurrences',
      copies([
        copyHref,
        storedCopy(
          'ACCEPTED',
          ...vevent(
            'UID:review@example.com',
            'RECURRENCE-ID:20261111T090000Z',
            'DTSTART:20261111T100000Z',
            'ORGANIZER:mailto:boss@example.com',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com',
          ),
        ),
      ]),
      accept,
      'InvitationError',
    ],
  ])('refuses %s without writing', async (_name, report, answer, tag) => {
    const { error, requests } = await failsOnFakeDav(
      routesWith(report),
      answerInvitation(davAccount, received(), answer, berlin),
    );
    expect(error).toMatchObject({ _tag: tag });
    expect(writeRequests(requests)).toEqual([]);
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
