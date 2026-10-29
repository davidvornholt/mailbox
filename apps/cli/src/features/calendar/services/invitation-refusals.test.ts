import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import type { Routes } from './caldav-write.fixture';
import { berlin, vevent } from './ical.fixture';
import type { ReceivedInvitation } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { answerInvitation, type InvitationAnswer } from './invitation-reply';
import {
  accept,
  copies,
  copyHref,
  occurrenceEvent,
  routesWith,
  storedCopy,
  storedSeries,
  weekly,
  withOccurrence,
} from './invitation-reply.fixture';

// An occurrence of the meeting that differs from the series, accepted.
const acceptedOccurrence = vevent(
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
  readonly routes?: Routes;
  readonly tag: string;
};

const refusals: ReadonlyArray<readonly [string, Refusal]> = [
  [
    'without --notify-organizer',
    {
      report: copies(),
      answer: { ...accept, notifyOrganizer: false },
      tag: 'EventHasAttendeesError',
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
      report: copies([copyHref, storedCopy('ACCEPTED', ...acceptedOccurrence)]),
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
    'to answer an occurrence the copy already answers',
    {
      report: copies([
        copyHref,
        withOccurrence(
          storedSeries('NEEDS-ACTION', weekly),
          occurrenceEvent('ACCEPTED'),
        ),
      ]),
      invitation: received(invitationIcs(...occurrenceEvent('NEEDS-ACTION'))),
      tag: 'InvitationError',
    },
  ],
  [
    'to answer an occurrence the organizer has changed the meeting since',
    {
      report: copies([
        copyHref,
        storedSeries('NEEDS-ACTION', weekly).replace(
          'SEQUENCE:0',
          'SEQUENCE:2',
        ),
      ]),
      invitation: received(invitationIcs(...occurrenceEvent('NEEDS-ACTION'))),
      tag: 'InvitationError',
    },
  ],
  [
    'to answer a meeting the calendar holds as cancelled',
    {
      report: copies([
        copyHref,
        storedCopy('NEEDS-ACTION')
          .replace('SEQUENCE:0', 'SEQUENCE:1')
          .replace('STATUS:CONFIRMED', 'STATUS:CANCELLED'),
      ]),
      tag: 'InvitationError',
    },
  ],
  [
    "to answer a copy that lists two of the user's addresses",
    {
      report: copies([
        copyHref,
        storedSeries(
          'ACCEPTED;SCHEDULE-AGENT=CLIENT',
          'ATTENDEE;PARTSTAT=TENTATIVE:mailto:alias@example.com',
        ),
      ]),
      routes: {
        'PROPFIND /principals/me/': {
          body: multistatus(
            davResponse(
              '/principals/me/',
              '<c:calendar-home-set><d:href>/calendars/me/</d:href></c:calendar-home-set><c:calendar-user-address-set><d:href>mailto:me@example.com</d:href><d:href>mailto:alias@example.com</d:href></c:calendar-user-address-set>',
            ),
          ),
        },
      },
      tag: 'InvitationError',
    },
  ],
];

describe('answerInvitation refusals', () => {
  it.each(refusals)(
    'refuses %s without writing',
    async (_name, {
      report,
      answer = accept,
      invitation = received(),
      routes,
      tag,
    }) => {
      const { error, requests } = await failsOnFakeDav(
        routesWith(report, routes),
        answerInvitation(davAccount, invitation, answer, berlin),
      );
      expect(error).toMatchObject({ _tag: tag });
      expect(writeRequests(requests)).toEqual([]);
    },
  );
});
