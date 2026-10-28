import { Clock, type DateTime, Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { describeCollections } from '../../../shared/dav/collections';
import { Dav } from '../../../shared/dav/dav';
import { discoverPrincipal } from '../../../shared/dav/discovery';
import {
  CalendarNotFoundError,
  EventChangeError,
  EventHasAttendeesError,
  InvitationError,
} from '../errors/errors';
import type { Calendar, EventDetail } from '../schemas/calendar';
import {
  createCalendarObject,
  fetchCalendarObject,
  listCalendars,
  replaceCalendarObject,
  schedulesFor,
} from './caldav';
import {
  type CalendarWriteError,
  detailOf,
  storedDetail,
  writableCalendar,
} from './calendar-write';
import { organizerAddress } from './event-attendees';
import { type CalendarObject, parseCalendar } from './event-fields';
import {
  answerOf,
  dropsOccurrences,
  giveAnswer,
  givesAnswer,
  type InvitationReply,
  invitationReply,
  ownAttendees,
  type Parties,
  type Partstat,
  partiesOf,
  type ReceivedInvitation,
  sentAnswerStatus,
  sequenceOf,
  unansweredCopy,
} from './invitation';
import { type EventCopy, findCopies, writable } from './invitation-copies';

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

// The calendar that holds the event, or gets it: the one wanted, else the
// only one the user may write to. None when the user may write to none.
const eventCalendar = (
  client: DavClient,
  account: Account,
  uid: string,
  wanted: string | undefined,
): Effect.Effect<
  { readonly calendar: Calendar; readonly copy?: EventCopy } | undefined,
  CalendarWriteError | InvitationError
> =>
  Effect.gen(function* () {
    const calendars = yield* listCalendars(client);
    const chosen =
      wanted === undefined
        ? undefined
        : yield* writableCalendar(account.email, calendars, wanted);
    const candidates = chosen === undefined ? writable(calendars) : [chosen];
    const copies = yield* findCopies(client, candidates, uid);
    const [copy, another] = copies;
    if (another !== undefined) {
      return yield* new InvitationError({
        message: `The meeting is in several calendars of ${account.email}: ${copies.map(({ resource }) => resource.href).join(', ')}. Pass --calendar to choose one`,
      });
    }
    if (copy !== undefined) {
      return { calendar: copy.calendar, copy };
    }
    const [only, second] = candidates;
    if (second !== undefined) {
      return yield* new CalendarNotFoundError({
        calendar: '',
        message: `${account.email} has several calendars; pass --calendar with the one to add the meeting to: ${describeCollections(candidates)}`,
      });
    }
    return only === undefined ? undefined : { calendar: only };
  });

// Adds the invitation to the calendar with the user's answer still open, so
// the server sends nothing yet, and reads the event back as stored.
const storeCopy = (
  client: DavClient,
  account: Account,
  {
    calendar,
    invitation,
    attendee,
  }: {
    readonly calendar: Calendar;
    readonly invitation: ReceivedInvitation;
    readonly attendee: string;
  },
  local: DateTime.TimeZone,
): Effect.Effect<EventCopy, CalendarWriteError> =>
  Effect.gen(function* () {
    const folder = calendar.href.endsWith('/')
      ? calendar.href
      : `${calendar.href}/`;
    const href = `${folder}${crypto.randomUUID()}.ics`;
    const ics = unansweredCopy(invitation, attendee);
    yield* detailOf(
      { account: account.email, href, etag: undefined, ics },
      local,
    );
    yield* createCalendarObject(client, href, ics);
    const resource = yield* fetchCalendarObject(client, href);
    return {
      calendar,
      resource,
      object: yield* parseCalendar(href, resource.ics),
    };
  });

type ServerAnswer = {
  readonly invitation: ReceivedInvitation;
  readonly parties: Parties;
  // The user's addresses the server knows.
  readonly addresses: ReadonlyArray<string>;
  readonly calendar: Calendar;
  readonly copy: EventCopy | undefined;
  readonly partstat: Partstat;
};

// Whether the server must be made to send the answer, which it otherwise
// sends only when the answer changes, or why pim cannot answer in the copy.
// The content replaces the stored event when the invitation is newer.
const forceFor = (
  {
    invitation,
    attendee,
    addresses,
    partstat,
  }: {
    readonly invitation: ReceivedInvitation;
    readonly attendee: string;
    readonly addresses: ReadonlyArray<string>;
    readonly partstat: Partstat;
  },
  href: string,
  {
    stored,
    content,
  }: { readonly stored: CalendarObject; readonly content: CalendarObject },
): Effect.Effect<boolean, InvitationError> => {
  const refuse = (message: string) =>
    Effect.fail(new InvitationError({ message }));
  if (answerOf(content, attendee) === undefined) {
    return refuse(
      `${href} does not list ${attendee} as an attendee, so pim cannot answer the meeting there`,
    );
  }
  // The server answers for whichever of the user's addresses it finds first.
  const own = ownAttendees(content, addresses);
  if (own.length > 1) {
    return refuse(
      `${href} lists ${own.join(' and ')} as attendees, so pim cannot answer for one of them alone. Answer it in a calendar app`,
    );
  }
  const replaces = content !== stored;
  if (replaces && dropsOccurrences(stored, content, attendee)) {
    return refuse(
      `${invitation.source} drops occurrences of the meeting that ${href} holds, and the server would send answers for those as well. Answer it in a calendar app`,
    );
  }
  const force = givesAnswer(stored, attendee, partstat);
  if (!force) {
    return Effect.succeed(false);
  }
  // sabre/dav drops SCHEDULE-FORCE-SEND after use only from the first event,
  // and a flag left stored would resend the answer on every later change, so
  // pim forces only a lone event.
  if (content.vcalendar.getAllSubcomponents('vevent').length > 1) {
    return refuse(
      `${href} already answers ${partstat}. pim cannot make the server send that answer again for a meeting with changed occurrences`,
    );
  }
  // An answer the server already sent, as when a write it committed failed
  // on the way back, goes out only once.
  const sent = sentAnswerStatus(stored);
  if (!replaces && sent !== undefined) {
    return refuse(
      `${href} already answers ${partstat}, and the server reports that it sent this answer to the organizer (SCHEDULE-STATUS ${sent}), so pim does not send it again`,
    );
  }
  return Effect.succeed(true);
};

// Gives the answer in the user's copy of the event, which makes the server
// send it to the organizer (RFC 6638, section 3.2.2.2). An invitation newer
// than the copy replaces it.
const answerOnServer = (
  client: DavClient,
  account: Account,
  { invitation, parties, addresses, calendar, copy, partstat }: ServerAnswer,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError | InvitationError> =>
  Effect.gen(function* () {
    const { attendee } = parties;
    const stored =
      copy ??
      (yield* storeCopy(
        client,
        account,
        { calendar, invitation, attendee },
        local,
      ));
    const { href, etag } = stored.resource;
    const organizer = organizerAddress(stored.object.master);
    if (organizer !== parties.organizer) {
      return yield* new InvitationError({
        message: `${href} holds a meeting with the same UID that ${organizer ?? 'nobody'} organizes, not ${parties.organizer}, so pim leaves it unchanged`,
      });
    }
    if (etag === undefined) {
      return yield* new EventChangeError({
        href,
        message: `The server gave no etag for ${href}, so pim cannot make sure it answers the version it read. The meeting is in the calendar, unanswered`,
      });
    }
    const content =
      invitation.sequence > sequenceOf(stored.object.master)
        ? yield* parseCalendar(href, unansweredCopy(invitation, attendee))
        : stored.object;
    const force = yield* forceFor(
      { invitation, attendee, addresses, partstat },
      href,
      { stored: stored.object, content },
    );
    giveAnswer(content, attendee, { partstat, force });
    const ics = content.vcalendar.toString();
    const detail = (newEtag: string | undefined) =>
      detailOf({ account: account.email, href, etag: newEtag, ics }, local);
    yield* detail(undefined);
    const written = yield* detail(
      yield* replaceCalendarObject(client, href, ics, etag),
    );
    return yield* storedDetail(client, written, local);
  });

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
    const addresses = principal.addresses.map((address) =>
      address.toLowerCase(),
    );
    const parties = yield* partiesFor(invitation, [
      account.email,
      ...addresses,
    ]);
    const place =
      addresses.includes(parties.attendee) && principal.calendarHomes.length > 0
        ? yield* eventCalendar(client, account, invitation.uid, answer.calendar)
        : undefined;
    if (
      place === undefined ||
      !(yield* schedulesFor(client, place.calendar.href))
    ) {
      return yield* replyOutcome(account, invitation, parties, partstat);
    }
    const { calendar, copy } = place;
    // The calendar keeps the series and its changed occurrences in one
    // object, which an answer for one occurrence alone would overwrite.
    if (invitation.object.master.hasProperty('recurrence-id')) {
      return yield* new InvitationError({
        message: `${invitation.source} is for one occurrence of a recurring meeting, which pim cannot answer in the calendar yet. Answer it in a calendar app`,
      });
    }
    if (!answer.notifyOrganizer) {
      return yield* new EventHasAttendeesError({
        href: copy?.resource.href ?? calendar.href,
        message: `Answering makes ${new URL(client.login.url).host} email the organizer ${parties.organizer}. Pass --notify-organizer only if the user asked to answer the invitation`,
      });
    }
    const event = yield* answerOnServer(
      client,
      account,
      { invitation, parties, addresses, calendar, copy, partstat },
      local,
    );
    return { _tag: 'Answered', event };
  });
