import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import type { Dav } from '../../../shared/dav/dav';
import {
  davAccount,
  failsOnFakeDav,
} from '../../../shared/dav/dav-server.fixture';
import { graphAccount } from '../../../shared/graph/graph-server.fixture';
import { createEvent, deleteEvent, updateEvent } from './calendar-write';
import { calendarRoutes, target, trip } from './calendar-write.fixture';
import { berlin } from './ical.fixture';
import { received } from './invitation.fixture';
import { importInvitation } from './invitation-import';
import { answerInvitation } from './invitation-reply';
import { refuseOutlookWrite } from './read-only';

const refusal = {
  _tag: 'OutlookReadOnlyError',
  account: 'me@example.com',
  message:
    'Outlook calendars are read-only in pim for now: me@example.com has only a graph table, so pim cannot create, change or delete its events or answer or import invitations into its calendars',
};

describe('refuseOutlookWrite', () => {
  it('refuses an account with only Outlook calendars', () => {
    expect(
      Effect.runSync(Effect.result(refuseOutlookWrite(graphAccount))),
    ).toMatchObject({
      failure: refusal,
    });
  });

  it('lets an account with a calendar server write there', () => {
    const both = { ...davAccount, graph: graphAccount.graph };
    for (const refused of [
      refuseOutlookWrite(davAccount),
      refuseOutlookWrite(davAccount, 'event-1'),
      refuseOutlookWrite(both),
      refuseOutlookWrite(both, '/calendars/me/work/m.ics'),
    ]) {
      expect(Effect.runSync(Effect.result(refused))).toEqual(Result.void);
    }
  });

  it('refuses to change an Outlook event of an account with both', async () => {
    const both = { ...davAccount, graph: graphAccount.graph };
    const { error, requests } = await failsOnFakeDav(
      calendarRoutes,
      deleteEvent(both, target({ href: 'event-1' }), berlin),
    );
    expect(error).toMatchObject({
      _tag: 'OutlookReadOnlyError',
      message:
        'Outlook calendars are read-only in pim for now: event-1 is an Outlook event of me@example.com, so pim cannot change or delete it. pim writes only to the calendars of accounts with a dav table, whose hrefs are paths',
    });
    expect(requests).toEqual([]);
  });
});

describe('calendar writes on an account with only Outlook calendars', () => {
  const writes: ReadonlyArray<Effect.Effect<unknown, unknown, Dav>> = [
    createEvent(
      graphAccount,
      { calendar: 'Calendar', ...trip, attendees: [], notifyAttendees: false },
      berlin,
    ),
    updateEvent(graphAccount, target(), { title: 'Planning, final' }, berlin),
    deleteEvent(graphAccount, target(), berlin),
    importInvitation(graphAccount, received(), undefined, berlin),
    answerInvitation(
      graphAccount,
      received(),
      { partstat: 'accepted', notifyOrganizer: true },
      berlin,
    ),
  ];

  it('fail before any request', async () => {
    const refused = await Promise.all(
      writes.map((write) => failsOnFakeDav(calendarRoutes, write)),
    );
    for (const { error, requests } of refused) {
      expect(error).toMatchObject(refusal);
      expect(requests).toEqual([]);
    }
  });
});
