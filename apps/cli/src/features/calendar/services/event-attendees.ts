import { Result } from 'effect';
import ICAL from 'ical.js';
import type { CalendarObject } from './event-fields';

// The user as the organizer of a meeting, with an address the server
// accepts as theirs.
export type Organizer = {
  readonly email: string;
  readonly name: string;
};

const mailtoScheme = /^mailto:/iu;

// An address pim writes into an invitation. It holds no space, quote, or
// separator, which would end or split the iCalendar value.
const emailAddress = /^[^\s"(),:;<>@[\\\]]+@[^\s"(),:;<>@[\\\]]+$/u;

const keyOf = (email: string): string => email.trim().toLowerCase();

export const addressOf = (property: ICAL.Property): string =>
  keyOf(String(property.getFirstValue() ?? '').replace(mailtoScheme, ''));

export const organizerAddress = (
  component: ICAL.Component,
): string | undefined => {
  const organizer = component.getFirstProperty('organizer');
  return organizer === null ? undefined : addressOf(organizer);
};

const attendeeAddresses = (component: ICAL.Component): Set<string> =>
  new Set(component.getAllProperties('attendee').map(addressOf));

// The attendees of any event in the object other than its organizer. A
// server that schedules (RFC 6638) emails them when the event changes or is
// deleted, or tells the organizer when an attendee deletes it.
export const otherAttendees = (
  vcalendar: ICAL.Component,
): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const vevent of vcalendar.getAllSubcomponents('vevent')) {
    const organizer = organizerAddress(vevent);
    for (const address of attendeeAddresses(vevent)) {
      if (address !== organizer) {
        found.add(address);
      }
    }
  }
  return [...found];
};

// The new attendees, each once, provided each is an email address and none
// is taken, as the organizer's and the current attendees' addresses are.
export const newAttendees = (
  emails: ReadonlyArray<string>,
  taken: ReadonlySet<string>,
): Result.Result<ReadonlyArray<string>, string> => {
  const invalid = emails.find((email) => !emailAddress.test(email.trim()));
  if (invalid !== undefined) {
    return Result.fail(`"${invalid}" is not an email address`);
  }
  const present = emails.find((email) => taken.has(keyOf(email)));
  if (present !== undefined) {
    return Result.fail(
      `${present.trim()} is already the organizer or an attendee`,
    );
  }
  const unique = new Map(emails.map((email) => [keyOf(email), email.trim()]));
  return Result.succeed([...unique.values()]);
};

export type AttendeeChanges = {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlySet<string>;
};

// The attendees to add to the series and to take off it, provided each
// change applies.
export const attendeeChanges = (
  master: ICAL.Component,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): Result.Result<AttendeeChanges, string> => {
  const present = attendeeAddresses(master);
  const organizer = organizerAddress(master);
  const added = newAttendees(
    add,
    organizer === undefined ? present : new Set([...present, organizer]),
  );
  if (Result.isFailure(added)) {
    return Result.fail(added.failure);
  }
  const missing = remove.find((email) => !present.has(keyOf(email)));
  return missing === undefined
    ? Result.succeed({
        added: added.success,
        removed: new Set(remove.map(keyOf)),
      })
    : Result.fail(`${missing.trim()} is not an attendee`);
};

const calendarAddress = (
  name: 'organizer' | 'attendee',
  email: string,
): ICAL.Property => {
  const property = new ICAL.Property(name);
  property.setValue(`mailto:${email}`);
  return property;
};

export const setOrganizer = (
  component: ICAL.Component,
  organizer: Organizer,
): void => {
  component.removeAllProperties('organizer');
  const property = calendarAddress('organizer', organizer.email);
  property.setParameter('cn', organizer.name);
  component.addProperty(property);
};

// An attendee the server invites and who is asked to reply.
const addAttendee = (component: ICAL.Component, email: string): void => {
  const property = calendarAddress('attendee', email);
  property.setParameter('role', 'REQ-PARTICIPANT');
  property.setParameter('partstat', 'NEEDS-ACTION');
  property.setParameter('rsvp', 'TRUE');
  component.addProperty(property);
};

export const addAttendees = (
  component: ICAL.Component,
  emails: ReadonlyArray<string>,
): void => {
  for (const email of emails) {
    addAttendee(component, email);
  }
};

// Invites and takes off attendees on the series and on each changed
// occurrence, and returns the events it changed.
export const changeAttendees = (
  { master, overrides }: CalendarObject,
  { added, removed }: AttendeeChanges,
): Set<ICAL.Component> => {
  const changed = new Set<ICAL.Component>();
  for (const component of [master, ...overrides]) {
    for (const property of component.getAllProperties('attendee')) {
      if (removed.has(addressOf(property))) {
        component.removeProperty(property);
        changed.add(component);
      }
    }
    const present = attendeeAddresses(component);
    const missing = added.filter((email) => !present.has(keyOf(email)));
    addAttendees(component, missing);
    if (missing.length > 0) {
      changed.add(component);
    }
  }
  return changed;
};

// Asks the attendees to reply again, as after the organizer moved the event.
export const resetReplies = (component: ICAL.Component): void => {
  const organizer = organizerAddress(component);
  for (const property of component.getAllProperties('attendee')) {
    if (addressOf(property) !== organizer) {
      property.setParameter('partstat', 'NEEDS-ACTION');
      property.setParameter('rsvp', 'TRUE');
    }
  }
};
