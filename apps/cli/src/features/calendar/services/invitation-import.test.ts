import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import { calendarRoutes, unfolded } from './calendar-write.fixture';
import { berlin } from './ical.fixture';
import { unansweredCopy } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { importInvitation } from './invitation-import';
import {
  copies,
  copyHref,
  newResource,
  routesWith,
  storedCopy,
} from './invitation-reply.fixture';

const leftToCalendarApp = 'ORGANIZER;CN=Boss;SCHEDULE-AGENT=CLIENT';

const cancellation = received(
  invitationIcs(...review('SEQUENCE:1')).replace(
    'METHOD:REQUEST',
    'METHOD:CANCEL',
  ),
);

describe('importInvitation', () => {
  it('adds a new meeting in two silent writes', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      routesWith(copies(), {
        'PUT /calendars/me/work/*': [
          { status: 201, headers: { etag: '"n1"' } },
          { status: 204, headers: { etag: '"n2"' } },
        ],
        'GET /calendars/me/work/*': {
          status: 200,
          headers: { etag: '"n2"' },
          body: unansweredCopy(received(), ['me@example.com']),
        },
      }),
      importInvitation(davAccount, received(), undefined, berlin),
    );
    const [create, restore, another] = writeRequests(requests);
    expect(another).toBeUndefined();
    expect(create?.url).toMatch(newResource);
    expect(create?.headers.get('if-none-match')).toBe('*');
    expect(create?.headers.get('schedule-reply')).toBe('F');
    expect(unfolded(create?.body)).toContain(leftToCalendarApp);
    expect(restore?.url).toBe(create?.url ?? '');
    expect(restore?.headers.get('if-match')).toBe('"n1"');
    expect(restore?.headers.get('schedule-reply')).toBe('F');
    expect(unfolded(restore?.body)).not.toContain('SCHEDULE-AGENT');
    expect(value).toMatchObject({
      status: 'created',
      event: { etag: '"n2"', summary: 'Review' },
    });
  });

  it('reads the new meeting back when the server gives no etag for it', async () => {
    const stored = unansweredCopy(received(), ['me@example.com']).replace(
      'ORGANIZER;CN=Boss',
      leftToCalendarApp,
    );
    const { requests } = await succeedsOnFakeDav(
      routesWith(copies(), {
        'PUT /calendars/me/work/*': { status: 201 },
        'GET /calendars/me/work/*': {
          status: 200,
          headers: { etag: '"n1"' },
          body: stored,
        },
      }),
      importInvitation(davAccount, received(), undefined, berlin),
    );
    const [, restore] = writeRequests(requests);
    expect(restore?.headers.get('if-match')).toBe('"n1"');
    expect(unfolded(restore?.body)).not.toContain('SCHEDULE-AGENT');
  });

  it('cancels the meeting in the copy without telling anyone', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('ACCEPTED')]), {
        [`PUT ${copyHref}`]: [
          { status: 204, headers: { etag: '"c2"' } },
          { status: 204, headers: { etag: '"c3"' } },
        ],
        [`GET ${copyHref}`]: {
          status: 200,
          headers: { etag: '"c3"' },
          body: storedCopy('ACCEPTED').replace('CONFIRMED', 'CANCELLED'),
        },
      }),
      importInvitation(davAccount, cancellation, undefined, berlin),
    );
    const [update, restore] = writeRequests(requests);
    expect(update?.headers.get('if-match')).toBe('"c1"');
    expect(unfolded(update?.body)).toContain('STATUS:CANCELLED');
    expect(restore?.headers.get('if-match')).toBe('"c2"');
    expect(
      [update, restore].map((write) => write?.headers.get('schedule-reply')),
    ).toEqual(['F', 'F']);
    expect(value).toMatchObject({
      status: 'updated',
      event: { status: 'cancelled' },
    });
  });

  it.each([
    ['current', received(), [copyHref, storedCopy('ACCEPTED')] as const],
    ['absent', cancellation, undefined],
  ] as const)(
    'writes nothing when the copy is %s',
    async (status, invitation, copy) => {
      const { value, requests } = await succeedsOnFakeDav(
        routesWith(copy === undefined ? copies() : copies(copy)),
        importInvitation(davAccount, invitation, undefined, berlin),
      );
      expect(value.status).toBe(status);
      expect(writeRequests(requests)).toEqual([]);
    },
  );
});

describe('importInvitation refusals', () => {
  it('asks to run the command again when the second write fails', async () => {
    const { error } = await failsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('ACCEPTED')]), {
        [`PUT ${copyHref}`]: [
          { status: 204, headers: { etag: '"c2"' } },
          { status: 412 },
        ],
      }),
      importInvitation(davAccount, cancellation, undefined, berlin),
    );
    expect(error).toMatchObject({ _tag: 'EventChangeError' });
    expect(error.message).toContain('Run the same pim command again');
  });

  it('refuses a calendar other than the one that holds the meeting', async () => {
    const { error, requests } = await failsOnFakeDav(
      routesWith(copies([copyHref, storedCopy('ACCEPTED')]), {
        'PROPFIND /calendars/me/': {
          body: multistatus(
            ...['work', 'home'].map((name) =>
              davResponse(
                `/calendars/me/${name}/`,
                `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname>`,
              ),
            ),
          ),
        },
        'REPORT /calendars/me/home/': copies(),
      }),
      importInvitation(davAccount, received(), 'home', berlin),
    );
    expect(error).toMatchObject({ _tag: 'InvitationError' });
    expect(error.message).toContain(`already in ${copyHref}`);
    expect(writeRequests(requests)).toEqual([]);
  });

  it('refuses an account without a calendar server', async () => {
    const { dav: _dav, ...mailAccount } = davAccount;
    const { error } = await failsOnFakeDav(
      calendarRoutes,
      importInvitation(mailAccount, received(), undefined, berlin),
    );
    expect(error).toMatchObject({ _tag: 'InvitationError' });
  });
});
