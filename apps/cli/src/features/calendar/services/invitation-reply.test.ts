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
import { type ReceivedInvitation, unansweredCopy } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { describeInvitation } from './invitation-copies';
import { answerInvitation, type InvitationAnswer } from './invitation-reply';

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

// An invitation for one occurrence of a recurring meeting.
const occurrence = invitationIcs(
  ...vevent(
    'ORGANIZER;CN=Boss:mailto:boss@example.com',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me:mailto:me@example.com',
    'UID:review@example.com',
    'RECURRENCE-ID;TZID=W. Europe Standard Time:20261111T100000',
    'SUMMARY:Review',
    'DTSTART;TZID=W. Europe Standard Time:20261111T120000',
    'DTEND;TZID=W. Europe Standard Time:20261111T130000',
    'DTSTAMP:20261028T080000Z',
    'SEQUENCE:1',
  ),
);

const weekly = 'RRULE:FREQ=WEEKLY;COUNT=3';

// An occurrence of the stored meeting that differs from the series.
const changed = vevent(
  'UID:review@example.com',
  'RECURRENCE-ID:20261111T090000Z',
  'DTSTART:20261111T100000Z',
  'ORGANIZER:mailto:boss@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com',
);

type Refusal = {
  readonly report: Routes[string];
  readonly answer?: InvitationAnswer;
  readonly invitation?: ReceivedInvitation;
  readonly tag: string;
};

describe('answerInvitation refusals', () => {
  it.each<readonly [string, Refusal]>([
    [
      'without --notify-organizer',
      {
        report: copies(),
        answer: { ...accept, notifyOrganizer: false },
        tag: 'EventHasAttendeesError',
      },
    ],
    [
      'an answer for one occurrence',
      {
        report: copies([copyHref, storedCopy('NEEDS-ACTION')]),
        invitation: received(occurrence),
        tag: 'InvitationError',
      },
    ],
    [
      'to answer a meeting with the same UID from another organizer',
      {
        report: copies([copyHref, storedCopy('NEEDS-ACTION')]),
        invitation: received(
          invitationIcs(...review()).replace(
            'boss@example.com',
            'other@example.com',
          ),
        ),
        tag: 'InvitationError',
      },
    ],
    [
      'when the meeting is in two calendars',
      {
        report: copies(
          [copyHref, storedCopy('NEEDS-ACTION')],
          ['/calendars/me/work/again.ics', storedCopy('NEEDS-ACTION')],
        ),
        tag: 'InvitationError',
      },
    ],
    [
      'to resend an answer for a meeting with changed occurrences',
      {
        report: copies([copyHref, storedCopy('ACCEPTED', ...changed)]),
        tag: 'InvitationError',
      },
    ],
    [
      'to send an answer again that the server reports sent',
      {
        report: copies([
          copyHref,
          storedCopy('ACCEPTED').replace(
            'ORGANIZER;CN=Boss',
            'ORGANIZER;CN=Boss;SCHEDULE-STATUS=1.1',
          ),
        ]),
        tag: 'InvitationError',
      },
    ],
    [
      'to store an update that excludes an occurrence',
      {
        report: copies([copyHref, storedCopy('ACCEPTED', weekly)]),
        invitation: received(
          invitationIcs(
            ...review(
              'SEQUENCE:1',
              weekly,
              'EXDATE;TZID=W. Europe Standard Time:20261111T100000',
            ),
          ),
        ),
        tag: 'InvitationError',
      },
    ],
    [
      'to store an update without a changed occurrence',
      {
        report: copies([copyHref, storedCopy('ACCEPTED', ...changed)]),
        invitation: received(invitationIcs(...review('SEQUENCE:1'))),
        tag: 'InvitationError',
      },
    ],
  ])(
    'refuses %s without writing',
    async (_name, {
      report,
      answer = accept,
      invitation = received(),
      tag,
    }) => {
      const { error, requests } = await failsOnFakeDav(
        routesWith(report),
        answerInvitation(davAccount, invitation, answer, berlin),
      );
      expect(error).toMatchObject({ _tag: tag });
      expect(writeRequests(requests)).toEqual([]);
    },
  );
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
