import ICAL from 'ical.js';
import { addressOf } from './event-attendees';
import { text } from './event-fields';
import { productId } from './event-write';
import {
  attendeeProperty,
  copyOf,
  type Parties,
  type Partstat,
  type ReceivedInvitation,
} from './invitation';

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
const replyIcs = (
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
