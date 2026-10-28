import { Effect, Result } from 'effect';
import ICAL from 'ical.js';
import { CalendarDataError } from '../errors/errors';
import { addressOf, isEmailAddress, organizerAddress } from './event-attendees';
import { type CalendarObject, parseCalendar, text } from './event-fields';
import { timeKey } from './ical-time';

export const partstats = ['accepted', 'tentative', 'declined'] as const;
export type Partstat = (typeof partstats)[number];

// An invitation as it arrived by email (iMIP, RFC 6047).
export type ReceivedInvitation = {
  // Where it came from, such as a message, for error messages.
  readonly source: string;
  // The iTIP method in lowercase, such as request or cancel. A calendar file
  // sent as a plain attachment has none.
  readonly method?: string;
  readonly uid: string;
  readonly sequence: number;
  readonly object: CalendarObject;
};

export const sequenceOf = (component: ICAL.Component): number => {
  const value = component.getFirstPropertyValue('sequence');
  return typeof value === 'number' ? value : 0;
};

// The method of the VCALENDAR wins over the one in the MIME type; RFC 6047
// requires them to match.
export const readInvitation = (
  source: string,
  ics: string,
  mimeMethod: string | undefined,
): Effect.Effect<ReceivedInvitation, CalendarDataError> =>
  parseCalendar(source, ics).pipe(
    Effect.flatMap((object) => {
      const uid = text(object.master, 'uid');
      const method = text(object.vcalendar, 'method') ?? mimeMethod;
      return uid === undefined
        ? Effect.fail(
            new CalendarDataError({
              href: source,
              message: `${source} holds an event without a UID, so pim cannot answer it or find it in a calendar`,
            }),
          )
        : Effect.succeed({
            ...(method === undefined ? {} : { method: method.toLowerCase() }),
            source,
            uid,
            sequence: sequenceOf(object.master),
            object,
          });
    }),
  );

export const eventsOf = ({
  master,
  overrides,
}: CalendarObject): ReadonlyArray<ICAL.Component> => [master, ...overrides];

// The occurrence an event describes: 'master' for the series, else its
// RECURRENCE-ID.
export const occurrenceKey = (event: ICAL.Component): string => {
  const property = event.getFirstProperty('recurrence-id');
  return property === null
    ? 'master'
    : timeKey(property.getFirstValue(), property.getParameter('tzid'));
};

// The occurrences an invitation to single occurrences is for, by
// occurrenceKey; none for an invitation to the series.
export const invitedOccurrences = ({
  object,
}: ReceivedInvitation): ReadonlySet<string> | undefined =>
  object.master.hasProperty('recurrence-id')
    ? new Set(eventsOf(object).map(occurrenceKey))
    : undefined;

// The events an answer covers: all of them, or the occurrences named.
export const answeredEvents = (
  object: CalendarObject,
  occurrences: ReadonlySet<string> | undefined,
): ReadonlyArray<ICAL.Component> =>
  eventsOf(object).filter(
    (event) =>
      occurrences === undefined || occurrences.has(occurrenceKey(event)),
  );

export const attendeeProperty = (
  event: ICAL.Component,
  attendee: string,
): ICAL.Property | undefined =>
  event
    .getAllProperties('attendee')
    .find((property) => addressOf(property) === attendee);

// The user's addresses that the object lists as attendees, in order.
export const ownAttendees = (
  object: CalendarObject,
  addresses: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const own = new Set(addresses.map((address) => address.toLowerCase()));
  return [
    ...new Set(
      eventsOf(object)
        .flatMap((event) => event.getAllProperties('attendee').map(addressOf))
        .filter((address) => own.has(address)),
    ),
  ];
};

// The first of the user's addresses that the object lists as an attendee.
export const ownAttendee = (
  object: CalendarObject,
  addresses: ReadonlyArray<string>,
): string | undefined => ownAttendees(object, addresses)[0];

const partstatOf = (property: ICAL.Property): string => {
  const value = property.getParameter('partstat');
  return typeof value === 'string' ? value.toLowerCase() : 'needs-action';
};

// The attendee's answer in the first of the occurrences given that lists
// them, or in the series when the object holds none of them.
export const answerOf = (
  object: CalendarObject,
  attendee: string,
  occurrences: ReadonlySet<string> | undefined,
): string | undefined => {
  const events = answeredEvents(object, occurrences);
  const property = (events.length === 0 ? eventsOf(object) : events)
    .map((event) => attendeeProperty(event, attendee))
    .find((found) => found !== undefined);
  return property === undefined ? undefined : partstatOf(property);
};

const leftToClient = (property: ICAL.Property | null | undefined): boolean => {
  const agent = property?.getParameter('schedule-agent');
  return typeof agent === 'string' && agent.toUpperCase() !== 'SERVER';
};

// Whether giving the answer in these events changes nothing the server
// sends answers for: each event that lists the attendee gives it already,
// and none leaves the attendee's answers to a calendar app (SCHEDULE-AGENT,
// RFC 6638, section 7.1), which the server then starts to send.
export const alreadyAnswers = (
  events: ReadonlyArray<ICAL.Component>,
  attendee: string,
  partstat: Partstat,
): boolean =>
  events.every((event) => {
    const property = attendeeProperty(event, attendee);
    return (
      property === undefined ||
      (partstatOf(property) === partstat && !leftToClient(property))
    );
  });

// The status by which the server reports that it sent the user's answer to
// the organizer: 1.x, sent or pending (RFC 6638, section 3.2.9).
export const sentAnswerStatus = (
  object: CalendarObject,
): string | undefined => {
  const status = object.master
    .getFirstProperty('organizer')
    ?.getParameter('schedule-status');
  return typeof status === 'string' && status.startsWith('1.')
    ? status
    : undefined;
};

// Who answers whom: the user's attendee address and the organizer's.
export type Parties = {
  readonly attendee: string;
  readonly organizer: string;
};

// The parties of an invitation the user can answer, or why they cannot.
export const partiesOf = (
  { method, object }: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
): Result.Result<Parties, string> => {
  if (method !== 'request') {
    return Result.fail(
      method === undefined
        ? 'holds a calendar file, not an invitation (it names no iTIP method)'
        : `is a ${method.toUpperCase()} message, not an invitation (REQUEST), so there is nothing to answer`,
    );
  }
  const organizer = organizerAddress(object.master);
  const own = addresses.map((address) => address.toLowerCase());
  const [attendee, another] = ownAttendees(object, own);
  if (organizer === undefined) {
    return Result.fail('names no organizer to answer');
  }
  if (!isEmailAddress(organizer)) {
    return Result.fail(
      `names the organizer "${organizer}", which is no single email address pim can answer`,
    );
  }
  if (own.includes(organizer)) {
    return Result.fail(
      `is from a meeting ${organizer} organizes, so there is nothing to answer`,
    );
  }
  if (attendee === undefined) {
    return Result.fail(
      `does not invite ${own.join(' or ')} as an attendee, so pim cannot answer it`,
    );
  }
  // A server that schedules answers for whichever of the user's addresses it
  // finds first, which need not be the one pim answers for.
  if (another !== undefined) {
    return Result.fail(
      `invites both ${attendee} and ${another}, so pim cannot answer for one of them alone. Answer it in a calendar app`,
    );
  }
  if (text(object.master, 'status')?.toUpperCase() === 'CANCELLED') {
    return Result.fail(
      'is for a cancelled meeting, so there is nothing to answer',
    );
  }
  return Result.succeed({ attendee, organizer });
};

// A copy of the data, so changes leave the original as it was.
export const copyOf = (component: ICAL.Component): ICAL.Component =>
  new ICAL.Component(ICAL.parse(component.toString()));

// A SCHEDULE-FORCE-SEND left stored would make the server send the answer
// again on every later change.
export const removeForcedSend = (event: ICAL.Component): void => {
  event.getFirstProperty('organizer')?.removeParameter('schedule-force-send');
};

// The invitation as a calendar stores it: without the iTIP method (RFC 4791,
// section 4.1), and with the answers of the user's addresses still open, so
// that storing it sends the organizer nothing.
export const unansweredCopy = (
  invitation: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
): string => {
  const vcalendar = copyOf(invitation.object.vcalendar);
  vcalendar.removeAllProperties('method');
  for (const event of vcalendar.getAllSubcomponents('vevent')) {
    for (const address of addresses) {
      attendeeProperty(event, address)?.setParameter(
        'partstat',
        'NEEDS-ACTION',
      );
    }
    removeForcedSend(event);
  }
  return vcalendar.toString();
};

export type Answer = {
  readonly partstat: Partstat;
  // Makes the server send the answer even where it does not change (RFC
  // 6638, section 7.3).
  readonly force: boolean;
  // The occurrences to answer, by occurrenceKey; all when absent.
  readonly occurrences?: ReadonlySet<string>;
};

// Gives the answer in the events it covers. A server that schedules always
// lets the organizer decide, so pim removes a SCHEDULE-AGENT that leaves the
// reply to a calendar app: from the organizer of every event, as RFC 6638
// requires the same value on all of them, and from the attendee in the
// events answered.
export const giveAnswer = (
  object: CalendarObject,
  attendee: string,
  { partstat, force, occurrences }: Answer,
): void => {
  for (const event of eventsOf(object)) {
    const organizer = event.getFirstProperty('organizer');
    if (leftToClient(organizer)) {
      organizer?.removeParameter('schedule-agent');
    }
    removeForcedSend(event);
  }
  for (const event of answeredEvents(object, occurrences)) {
    const property = attendeeProperty(event, attendee);
    property?.setParameter('partstat', partstat.toUpperCase());
    if (leftToClient(property)) {
      property?.removeParameter('schedule-agent');
    }
  }
  if (force) {
    object.master
      .getFirstProperty('organizer')
      ?.setParameter('schedule-force-send', 'REPLY');
  }
};
