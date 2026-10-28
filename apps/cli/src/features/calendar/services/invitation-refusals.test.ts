import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  davResponse,
  failsOnFakeDav,
  multistatus,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import type { Routes } from './calendar-write.fixture';
import { berlin, vevent } from './ical.fixture';
import type { ReceivedInvitation } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { answerInvitation, type InvitationAnswer } from './invitation-reply';
import {
  accept,
  copies,
  copyHref,
  routesWith,
  storedCopy,
} from './invitation-reply.fixture';

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

// The stored meeting with more lines in its main event.
const storedSeries = (partstat: string, ...lines: ReadonlyArray<string>) =>
  storedCopy(partstat).replace(
    'SEQUENCE:0',
    ['SEQUENCE:0', ...lines].join('\r\n'),
  );

// An occurrence of the meeting that differs from the series.
const changed = (attendee: string) =>
  vevent(
    'UID:review@example.com',
    'RECURRENCE-ID:20261111T090000Z',
    'DTSTART:20261111T100000Z',
    'ORGANIZER:mailto:boss@example.com',
    attendee,
  );

const acceptedOccurrence = changed(
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
    'to store an update that excludes an occurrence',
    {
      report: copies([copyHref, storedSeries('ACCEPTED', weekly)]),
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
  ...[
    'ATTENDEE:mailto:ana@example.com',
    'ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:me@example.com',
  ].map((attendee): readonly [string, Refusal] => [
    `to store an update whose changed occurrence lists ${attendee}`,
    {
      report: copies([
        copyHref,
        storedCopy(
          'NEEDS-ACTION',
          ...changed('ATTENDEE:mailto:me@example.com'),
        ),
      ]),
      invitation: received(
        invitationIcs(...review('SEQUENCE:1'), ...changed(attendee)),
      ),
      tag: 'InvitationError',
    },
  ]),
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
  [
    'to store an update without a changed occurrence',
    {
      report: copies([copyHref, storedCopy('ACCEPTED', ...acceptedOccurrence)]),
      invitation: received(invitationIcs(...review('SEQUENCE:1'))),
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
