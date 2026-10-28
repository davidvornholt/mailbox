import { Clock, type DateTime, Effect, Result } from 'effect';
import type ICAL from 'ical.js';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { Dav } from '../../../shared/dav/dav';
import { discoverPrincipal } from '../../../shared/dav/discovery';
import {
  EventChangeError,
  EventHasAttendeesError,
  InvitationError,
} from '../errors/errors';
import type { EventDetail } from '../schemas/calendar';
import { replaceCalendarObject, schedulesFor } from './caldav';
import {
  type CalendarWriteError,
  detailOf,
  storedDetail,
} from './calendar-write';
import type { CalendarObject } from './event-fields';
import {
  alreadyAnswers,
  answeredEvents,
  attendeeProperty,
  eventsOf,
  giveAnswer,
  invitedOccurrences,
  ownAttendees,
  type Parties,
  type Partstat,
  partiesOf,
  type ReceivedInvitation,
  sentAnswerStatus,
} from './invitation';
import type { EventCopy } from './invitation-copies';
import {
  applyImport,
  type MeetingPlace,
  meetingPlace,
  newMeetingCalendar,
  plannedChange,
  plannedCopy,
} from './invitation-import';
import {
  type InvitationReply,
  invitationReply,
} from './invitation-reply-email';
import { userAddresses } from './scheduling';

export type InvitationAnswer = {
  readonly partstat: Partstat;
  // A calendar name or href for an event in no calendar yet.
  readonly calendar?: string;
  // Allows the answer that makes the server email the organizer.
  readonly notifyOrganizer: boolean;
};

// The calendar server sent the answer, or the user sends the reply email.
export type AnswerOutcome =
  | { readonly _tag: 'Answered'; readonly event: EventDetail }
  | { readonly _tag: 'Reply'; readonly reply: InvitationReply };

export type InvitationAnswerError = CalendarWriteError | InvitationError;

const partiesFor = (
  invitation: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
): Effect.Effect<Parties, InvitationError> =>
  Result.match(partiesOf(invitation, addresses), {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(
        new InvitationError({ message: `${invitation.source} ${reason}` }),
      ),
  });

const replyOutcome = (
  account: Account,
  invitation: ReceivedInvitation,
  parties: Parties,
  partstat: Partstat,
): Effect.Effect<AnswerOutcome> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((nowMs) => ({
      _tag: 'Reply',
      reply: invitationReply(invitation, parties, {
        name: account.name,
        partstat,
        nowMs,
      }),
    })),
  );

// The answer pim gives in the user's copy of the meeting.
type CopyAnswer = {
  readonly attendee: string;
  // The user's addresses, in lowercase.
  readonly addresses: ReadonlyArray<string>;
  readonly partstat: Partstat;
  // The occurrences an invitation to single occurrences is for, by
  // occurrenceKey; none for the series.
  readonly occurrences: ReadonlySet<string> | undefined;
};

const isCancelled = (event: ICAL.Component): boolean =>
  String(event.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED';

// Why pim cannot answer in the copy, if it cannot: sabre/dav sends no
// answer for a cancelled meeting, and answers for whichever of the user's
// addresses it finds first.
const answerRefusal = (
  { attendee, addresses, occurrences }: CopyAnswer,
  href: string,
  object: CalendarObject,
): string | undefined => {
  const events = answeredEvents(object, occurrences);
  if (events.length === 0) {
    return `${href} does not hold the occurrence the invitation is for, as the organizer has changed the meeting since. Answer the latest invitation for it`;
  }
  if (!events.some((event) => attendeeProperty(event, attendee))) {
    return `${href} does not list ${attendee} as an attendee, so pim cannot answer the meeting there`;
  }
  if (isCancelled(object.master) || events.every(isCancelled)) {
    return `${href} holds the meeting as cancelled, so there is nothing to answer`;
  }
  const own = ownAttendees(object, addresses);
  return own.length > 1
    ? `${href} lists ${own.join(' and ')} as attendees, so pim cannot answer for one of them alone. Answer it in a calendar app`
    : undefined;
};

// Why the server cannot be made to send an answer the copy already gives,
// which it otherwise sends only when the answer changes. sabre/dav would
// send all occurrences, drops SCHEDULE-FORCE-SEND after use only from the
// first event, and a flag left stored would resend the answer on every
// later change, so pim forces only a lone event.
const resendRefusal = (
  { partstat, occurrences }: CopyAnswer,
  href: string,
  object: CalendarObject,
): string | undefined => {
  if (occurrences !== undefined) {
    return `${href} already answers ${partstat} for this occurrence. pim cannot make the server send that answer again for one occurrence`;
  }
  if (eventsOf(object).length > 1) {
    return `${href} already answers ${partstat}. pim cannot make the server send that answer again for a meeting with changed occurrences`;
  }
  // An answer the server already sent, as when a write it committed failed
  // on the way back, goes out only once.
  const sent = sentAnswerStatus(object);
  return sent === undefined
    ? undefined
    : `${href} already answers ${partstat}, and the server reports that it sent this answer to the organizer (SCHEDULE-STATUS ${sent}), so pim does not send it again`;
};

// Whether the server must be made to send the answer, or why pim cannot
// answer the meeting as the copy holds it.
const forceFor = (
  answer: CopyAnswer,
  href: string,
  object: CalendarObject,
): Effect.Effect<boolean, InvitationError> => {
  const refusal =
    answerRefusal(answer, href, object) ??
    (alreadyAnswers(
      answeredEvents(object, answer.occurrences),
      answer.attendee,
      answer.partstat,
    )
      ? (resendRefusal(answer, href, object) ?? true)
      : false);
  return typeof refusal === 'string'
    ? Effect.fail(new InvitationError({ message: refusal }))
    : Effect.succeed(refusal);
};

const answerPut = (
  client: DavClient,
  { resource }: EventCopy,
  ics: string,
): Effect.Effect<string | undefined, CalendarWriteError | InvitationError> =>
  Effect.gen(function* () {
    const { href, etag } = resource;
    if (etag === undefined) {
      return yield* new EventChangeError({
        href,
        message: `The server gave no etag for ${href}, so pim cannot make sure it answers the version it read. The meeting is in the calendar, unanswered`,
      });
    }
    return yield* replaceCalendarObject(client, href, ics, etag).pipe(
      Effect.catchTag('DavError', (error) =>
        Effect.fail(
          error.uncertain === true
            ? new InvitationError({
                message: `${error.message}. The server may have stored the answer and emailed it to the organizer. Run "pim calendar invitation" to see the answer the calendar holds before answering again`,
              })
            : error,
        ),
      ),
    );
  });

// Brings the user's copy of the meeting up to date with the invitation,
// silently, and gives the answer there, which makes the server send it to
// the organizer (RFC 6638, section 3.2.2.2). pim checks the answer against
// the copy it plans before it writes anything.
const answerOnServer = (
  client: DavClient,
  account: Account,
  {
    invitation,
    place,
    answer,
  }: {
    readonly invitation: ReceivedInvitation;
    readonly place: MeetingPlace;
    readonly answer: CopyAnswer;
  },
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError | InvitationError> =>
  Effect.gen(function* () {
    const change = yield* plannedChange(invitation, answer.addresses, place);
    const planned = yield* plannedCopy(place, change);
    if (planned !== undefined) {
      yield* forceFor(answer, place.copy?.resource.href ?? 'The copy', planned);
    }
    const { copy } = yield* applyImport(
      client,
      account,
      { place, change },
      local,
    );
    if (copy === undefined) {
      return yield* new InvitationError({
        message: `${invitation.source} left no meeting in the calendar to answer`,
      });
    }
    const { href } = copy.resource;
    const force = yield* forceFor(answer, href, copy.object);
    giveAnswer(copy.object, answer.attendee, {
      partstat: answer.partstat,
      force,
      ...(answer.occurrences === undefined
        ? {}
        : { occurrences: answer.occurrences }),
    });
    const ics = copy.object.vcalendar.toString();
    const detail = (etag: string | undefined) =>
      detailOf({ account: account.email, href, etag, ics }, local);
    yield* detail(undefined);
    const written = yield* detail(yield* answerPut(client, copy, ics));
    return yield* storedDetail(client, written, local);
  });

// The calendar that holds the meeting, or gets it.
const placeCalendar = (account: Account, place: MeetingPlace) =>
  place.copy === undefined
    ? newMeetingCalendar(account, place.calendars)
    : Effect.succeed(place.copy.calendar);

// Answers the invitation through the calendar server when it can send the
// answer itself (RFC 6638), and otherwise returns the reply email for the
// user to send. Only the server path writes to a calendar.
export const answerInvitation = (
  account: Account,
  invitation: ReceivedInvitation,
  answer: InvitationAnswer,
  local: DateTime.TimeZone,
): Effect.Effect<AnswerOutcome, InvitationAnswerError, Dav> =>
  Effect.gen(function* () {
    const { partstat } = answer;
    if (account.dav === undefined) {
      const parties = yield* partiesFor(invitation, [account.email]);
      return yield* replyOutcome(account, invitation, parties, partstat);
    }
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const principal = yield* discoverPrincipal(client);
    const known = principal.addresses.map((address) => address.toLowerCase());
    const addresses = userAddresses(account, known);
    const parties = yield* partiesFor(invitation, addresses);
    const place =
      known.includes(parties.attendee) && principal.calendarHomes.length > 0
        ? yield* meetingPlace(client, account, invitation.uid, answer.calendar)
        : undefined;
    const calendar =
      place === undefined ? undefined : yield* placeCalendar(account, place);
    if (
      place === undefined ||
      calendar === undefined ||
      !(yield* schedulesFor(client, calendar.href))
    ) {
      return yield* replyOutcome(account, invitation, parties, partstat);
    }
    if (!answer.notifyOrganizer) {
      return yield* new EventHasAttendeesError({
        href: place.copy?.resource.href ?? calendar.href,
        message: `Answering makes ${new URL(client.login.url).host} email the organizer ${parties.organizer}. Pass --notify-organizer only if the user asked to answer the invitation`,
      });
    }
    const event = yield* answerOnServer(
      client,
      account,
      {
        invitation,
        place,
        answer: {
          attendee: parties.attendee,
          addresses,
          partstat,
          occurrences: invitedOccurrences(invitation),
        },
      },
      local,
    );
    return { _tag: 'Answered', event };
  });
