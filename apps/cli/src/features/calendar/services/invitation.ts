import { Effect, Result } from 'effect';
import ICAL from 'ical.js';
import { CalendarDataError } from '../errors/errors';
import { addressOf, organizerAddress } from './event-attendees';
import { type CalendarObject, parseCalendar, text } from './event-fields';
import { productId } from './event-write';

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

const eventsOf = ({
  master,
  overrides,
}: CalendarObject): ReadonlyArray<ICAL.Component> => [master, ...overrides];

const attendeeProperty = (
  event: ICAL.Component,
  attendee: string,
): ICAL.Property | undefined =>
  event
    .getAllProperties('attendee')
    .find((property) => addressOf(property) === attendee);

// The first of the user's addresses that the object lists as an attendee.
export const ownAttendee = (
  object: CalendarObject,
  addresses: ReadonlyArray<string>,
): string | undefined => {
  const own = new Set(addresses.map((address) => address.toLowerCase()));
  return eventsOf(object)
    .flatMap((event) => event.getAllProperties('attendee').map(addressOf))
    .find((address) => own.has(address));
};

const partstatOf = (property: ICAL.Property): string => {
  const value = property.getParameter('partstat');
  return typeof value === 'string' ? value.toLowerCase() : 'needs-action';
};

// The attendee's answer in the first event that lists them.
export const answerOf = (
  object: CalendarObject,
  attendee: string,
): string | undefined => {
  const property = eventsOf(object)
    .map((event) => attendeeProperty(event, attendee))
    .find((found) => found !== undefined);
  return property === undefined ? undefined : partstatOf(property);
};

// Whether every event that lists the attendee already gives the answer.
export const givesAnswer = (
  object: CalendarObject,
  attendee: string,
  partstat: Partstat,
): boolean =>
  eventsOf(object).every((event) => {
    const property = attendeeProperty(event, attendee);
    return property === undefined || partstatOf(property) === partstat;
  });

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
  const attendee = ownAttendee(object, own);
  if (organizer === undefined) {
    return Result.fail('names no organizer to answer');
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
  if (text(object.master, 'status')?.toUpperCase() === 'CANCELLED') {
    return Result.fail(
      'is for a cancelled meeting, so there is nothing to answer',
    );
  }
  return Result.succeed({ attendee, organizer });
};

// A copy of the data, so changes leave the invitation as it arrived.
const copyOf = (vcalendar: ICAL.Component): ICAL.Component =>
  new ICAL.Component(ICAL.parse(vcalendar.toString()));

// The invitation as a calendar stores it: without the iTIP method (RFC 4791,
// section 4.1), and with the user's answer still open, so that storing it
// sends the organizer nothing.
export const unansweredCopy = (
  invitation: ReceivedInvitation,
  attendee: string,
): string => {
  const vcalendar = copyOf(invitation.object.vcalendar);
  vcalendar.removeAllProperties('method');
  for (const event of vcalendar.getAllSubcomponents('vevent')) {
    attendeeProperty(event, attendee)?.setParameter('partstat', 'NEEDS-ACTION');
  }
  return vcalendar.toString();
};

// Gives the answer in every event that lists the attendee. With force, the
// server sends it even where the answer does not change (RFC 6638, section
// 7.3). A server that schedules always lets the organizer decide, so pim
// removes a SCHEDULE-AGENT that leaves the reply to a calendar app.
export const giveAnswer = (
  object: CalendarObject,
  attendee: string,
  { partstat, force }: { readonly partstat: Partstat; readonly force: boolean },
): void => {
  for (const event of eventsOf(object)) {
    attendeeProperty(event, attendee)?.setParameter(
      'partstat',
      partstat.toUpperCase(),
    );
    const organizer = event.getFirstProperty('organizer');
    const agent = organizer?.getParameter('schedule-agent');
    if (typeof agent === 'string' && agent.toUpperCase() !== 'SERVER') {
      organizer?.removeParameter('schedule-agent');
    }
  }
  if (force) {
    object.master
      .getFirstProperty('organizer')
      ?.setParameter('schedule-force-send', 'REPLY');
  }
};

const replyProperties = new Set([
  'uid',
  'recurrence-id',
  'sequence',
  'dtstart',
  'dtend',
  'duration',
  'summary',
  'organizer',
  'attendee',
]);

const schedulingParameters = [
  'rsvp',
  'schedule-agent',
  'schedule-force-send',
  'schedule-status',
];

const replyEvent = (
  vevent: ICAL.Component,
  attendee: string,
  { partstat, nowMs }: { readonly partstat: Partstat; readonly nowMs: number },
): void => {
  vevent.removeAllSubcomponents();
  for (const property of [...vevent.getAllProperties()]) {
    if (
      !replyProperties.has(property.name) ||
      (property.name === 'attendee' && addressOf(property) !== attendee)
    ) {
      vevent.removeProperty(property);
    }
  }
  for (const property of vevent.getAllProperties()) {
    for (const name of schedulingParameters) {
      property.removeParameter(name);
    }
  }
  attendeeProperty(vevent, attendee)?.setParameter(
    'partstat',
    partstat.toUpperCase(),
  );
  vevent.addPropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(nowMs), true),
  );
};

// The iTIP REPLY (RFC 5546, section 3.2.3) that gives the attendee's answer
// for each event of the invitation that lists them.
export const replyIcs = (
  invitation: ReceivedInvitation,
  attendee: string,
  answer: { readonly partstat: Partstat; readonly nowMs: number },
): string => {
  const vcalendar = copyOf(invitation.object.vcalendar);
  vcalendar.removeAllProperties();
  vcalendar.addPropertyWithValue('version', '2.0');
  vcalendar.addPropertyWithValue('prodid', productId);
  vcalendar.addPropertyWithValue('method', 'REPLY');
  for (const component of [...vcalendar.getAllSubcomponents()]) {
    if (
      component.name === 'vevent' &&
      attendeeProperty(component, attendee) !== undefined
    ) {
      replyEvent(component, attendee, answer);
    } else if (component.name !== 'vtimezone') {
      vcalendar.removeSubcomponent(component);
    }
  }
  return vcalendar.toString();
};

const answerWords: Record<
  Partstat,
  { readonly subject: string; readonly verb: string }
> = {
  accepted: { subject: 'Accepted', verb: 'accepted' },
  tentative: { subject: 'Tentative', verb: 'tentatively accepted' },
  declined: { subject: 'Declined', verb: 'declined' },
};

// An email that answers an invitation, for the user to send.
export type InvitationReply = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly ics: string;
};

export const invitationReply = (
  invitation: ReceivedInvitation,
  { attendee, organizer }: Parties,
  answer: {
    readonly name: string;
    readonly partstat: Partstat;
    readonly nowMs: number;
  },
): InvitationReply => {
  const words = answerWords[answer.partstat];
  const summary = text(invitation.object.master, 'summary');
  return {
    to: organizer,
    subject:
      summary === undefined ? words.subject : `${words.subject}: ${summary}`,
    text: `${answer.name.trim() || attendee} has ${words.verb} this invitation.\n`,
    ics: replyIcs(invitation, attendee, answer),
  };
};
