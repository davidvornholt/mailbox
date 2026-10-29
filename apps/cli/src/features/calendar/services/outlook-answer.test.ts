import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { davAccount } from '../../../shared/dav/dav-server.fixture';
import {
  fakeGraph,
  GraphReply,
  graphAccount,
  onFakeGraph,
} from '../../../shared/graph/graph-server.fixture';
import { berlin } from './ical.fixture';
import {
  answerOutlookEvent,
  answerOutlookMeeting,
  type OutlookAnswer,
} from './outlook-answer';

const acceptedCode = 202;

const invited = {
  id: 'event-1',
  subject: 'Review',
  start: { dateTime: '2026-11-03T13:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-03T14:00:00.0000000', timeZone: 'UTC' },
  isOrganizer: false,
  organizer: { emailAddress: { address: 'ann@example.com' } },
  attendees: [
    {
      emailAddress: { address: 'me@example.com' },
      status: { response: 'none' },
    },
  ],
  responseStatus: { response: 'notResponded' },
};

const answer: OutlookAnswer = {
  href: 'event-1',
  partstat: 'accepted',
  series: false,
  notifyOrganizer: false,
};

describe('answerOutlookEvent', () => {
  it('keeps the answer in the calendar and tells no one by default', async () => {
    const { client, requests } = fakeGraph({
      '/me/events/event-1': [
        invited,
        { ...invited, responseStatus: { response: 'accepted' } },
      ],
      'POST /me/events/event-1/accept': new GraphReply(acceptedCode),
    });
    const answered = await Effect.runPromise(
      answerOutlookEvent(client, answer, berlin),
    );
    expect(answered).toMatchObject({
      notified: false,
      event: {
        attendees: [{ email: 'me@example.com', partstat: 'accepted' }],
      },
    });
    expect(requests.filter(({ method }) => method !== undefined)).toEqual([
      {
        url: 'https://graph.microsoft.com/v1.0/me/events/event-1/accept',
        prefer: undefined,
        method: 'POST',
        body: { sendResponse: false },
      },
    ]);
  });

  it('tells the organizer when asked and leaves out a removed meeting', async () => {
    const { client, requests } = fakeGraph({
      '/me/events/event-1': [invited, new GraphReply(404, {})],
      'POST /me/events/event-1/decline': new GraphReply(acceptedCode),
    });
    const answered = await Effect.runPromise(
      answerOutlookEvent(
        client,
        { ...answer, partstat: 'declined', notifyOrganizer: true },
        berlin,
      ),
    );
    expect(answered).toEqual({ notified: true });
    expect(requests.find(({ method }) => method === 'POST')?.body).toEqual({
      sendResponse: true,
    });
  });

  it('answers no meeting the user organizes, and a series only with series', async () => {
    const refusals = await Promise.all(
      [
        { ...invited, isOrganizer: true },
        { ...invited, type: 'seriesMaster' },
      ].map(async (event) => {
        const { client, requests } = fakeGraph({ '/me/events/event-1': event });
        const error = await Effect.runPromise(
          Effect.flip(answerOutlookEvent(client, answer, berlin)),
        );
        return [
          error._tag,
          requests.filter(({ method }) => method !== undefined),
        ];
      }),
    );
    expect(refusals).toEqual([
      ['InvitationError', []],
      ['InvitationError', []],
    ]);
  });
});

describe('answerOutlookMeeting', () => {
  it('answers only an Outlook meeting', async () => {
    const both = { ...davAccount, graph: graphAccount.graph };
    const refusals = await Promise.all(
      [
        answerOutlookMeeting(davAccount, answer, berlin),
        answerOutlookMeeting(
          both,
          { ...answer, href: '/calendars/me/work/m.ics' },
          berlin,
        ),
      ].map((answering) => {
        const { effect, requests } = onFakeGraph({}, answering);
        return Effect.runPromise(Effect.flip(effect)).then((error) => [
          error._tag,
          requests,
        ]);
      }),
    );
    expect(refusals).toEqual([
      ['InvitationError', []],
      ['InvitationError', []],
    ]);
  });
});
