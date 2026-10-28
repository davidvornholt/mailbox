import { Result } from 'effect';
import ICAL from 'ical.js';
import { isEmailAddress, organizerAddress } from './event-attendees';
import type { CalendarObject } from './event-fields';
import {
  attendeeProperty,
  copyOf,
  eventsOf,
  occurrenceKey,
  ownAttendees,
  type ReceivedInvitation,
  removeForcedSend,
  sequenceOf,
  unansweredCopy,
} from './invitation';

// What a message from the organizer does to the user's copy of the meeting.
export type ImportChange =
  // The calendar does not hold the meeting yet: the copy to add.
  | { readonly _tag: 'Create'; readonly ics: string }
  // The copy as the message changes it.
  | { readonly _tag: 'Change'; readonly vcalendar: ICAL.Component }
  // The copy already holds this message or a newer one.
  | { readonly _tag: 'Current' }
  // A cancellation of a meeting the calendar does not hold.
  | { readonly _tag: 'Absent' };

// Why pim does not import the message, as words after its source.
export const importRefusal = (
  { method, object }: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
): string | undefined => {
  if (method !== 'request' && method !== 'cancel') {
    return method === undefined
      ? 'holds a calendar file, not a message from an organizer (it names no iTIP method)'
      : `is a ${method.toUpperCase()} message; pim imports only invitations (REQUEST) and cancellations (CANCEL)`;
  }
  const organizer = organizerAddress(object.master);
  if (organizer === undefined || !isEmailAddress(organizer)) {
    return `names ${organizer === undefined ? 'no organizer' : `the organizer "${organizer}"`}, so pim cannot tell whose meeting it changes`;
  }
  if (addresses.includes(organizer)) {
    return `is from a meeting ${organizer} organizes; change it with "pim calendar update"`;
  }
  if (method === 'request' && ownAttendees(object, addresses).length === 0) {
    return `does not invite ${addresses.join(' or ')} as an attendee`;
  }
  const range = eventsOf(object).some(
    (event) =>
      event.getFirstProperty('recurrence-id')?.getParameter('range') !==
      undefined,
  );
  return range
    ? 'changes an occurrence and all later ones (RANGE), which pim cannot import. Use a calendar app'
    : undefined;
};

const stampOf = (event: ICAL.Component): number | undefined => {
  const value = event.getFirstPropertyValue('dtstamp');
  return value instanceof ICAL.Time ? value.toUnixTime() : undefined;
};

// Messages about an event come in order of SEQUENCE, and of DTSTAMP within
// one SEQUENCE (RFC 5546, section 2.1.5).
const isNewer = (
  incoming: ICAL.Component,
  stored: ICAL.Component | undefined,
): boolean => {
  if (stored === undefined) {
    return true;
  }
  const sequence = sequenceOf(incoming) - sequenceOf(stored);
  if (sequence !== 0) {
    return sequence > 0;
  }
  const incomingStamp = stampOf(incoming);
  const storedStamp = stampOf(stored);
  return (
    incomingStamp !== undefined &&
    storedStamp !== undefined &&
    incomingStamp > storedStamp
  );
};

const eventAt = (
  vcalendar: ICAL.Component,
  key: string,
): ICAL.Component | undefined =>
  vcalendar
    .getAllSubcomponents('vevent')
    .find((event) => occurrenceKey(event) === key);

// Keeps what belongs to the user in an event the organizer sent: the
// reminders and answers of the stored event it replaces, or of the series
// for an occurrence new to the calendar. An organizer who wants the answers
// again raises the SEQUENCE (RFC 5546, section 2.1.4); the answers then
// stay open.
const carryOver = (
  event: ICAL.Component,
  before: ICAL.Component | undefined,
  addresses: ReadonlyArray<string>,
): void => {
  removeForcedSend(event);
  const answered =
    before !== undefined && sequenceOf(before) === sequenceOf(event);
  for (const address of addresses) {
    const earlier = answered
      ? attendeeProperty(before, address)?.getParameter('partstat')
      : undefined;
    attendeeProperty(event, address)?.setParameter(
      'partstat',
      typeof earlier === 'string' ? earlier : 'NEEDS-ACTION',
    );
  }
  if (before !== undefined) {
    event.removeAllSubcomponents('valarm');
    for (const alarm of before.getAllSubcomponents('valarm')) {
      event.addSubcomponent(copyOf(alarm));
    }
  }
};

const addTimezones = (vcalendar: ICAL.Component, from: ICAL.Component) => {
  const known = new Set(
    vcalendar
      .getAllSubcomponents('vtimezone')
      .map((zone) => String(zone.getFirstPropertyValue('tzid'))),
  );
  for (const zone of from.getAllSubcomponents('vtimezone')) {
    if (!known.has(String(zone.getFirstPropertyValue('tzid')))) {
      vcalendar.addSubcomponent(copyOf(zone));
    }
  }
};

const organizers = (vcalendar: ICAL.Component) =>
  vcalendar
    .getAllSubcomponents('vevent')
    .flatMap((event) => event.getAllProperties('organizer'));

const leavesToClient = (property: ICAL.Property): boolean =>
  String(property.getParameter('schedule-agent')).toUpperCase() === 'CLIENT';

// The copy with SCHEDULE-AGENT=CLIENT on each organizer, which tells a
// server that schedules (RFC 6638, section 3.2.2.3) that a calendar app
// answers the meeting, so that it sends nothing for this write.
export const leftToCalendarApp = (
  vcalendar: ICAL.Component,
): ICAL.Component => {
  const copy = copyOf(vcalendar);
  for (const organizer of organizers(copy)) {
    organizer.setParameter('schedule-agent', 'CLIENT');
  }
  return copy;
};

// The copy without SCHEDULE-AGENT=CLIENT on its organizers.
export const leftToServer = (vcalendar: ICAL.Component): ICAL.Component => {
  const copy = copyOf(vcalendar);
  for (const organizer of organizers(copy)) {
    if (leavesToClient(organizer)) {
      organizer.removeParameter('schedule-agent');
    }
  }
  return copy;
};

// A copy that already holds the message. One whose organizer still leaves
// answers to a calendar app, while the message does not, is one pim stopped
// writing halfway; the change finishes that.
const current = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
): ImportChange => {
  const unfinished =
    organizers(stored.vcalendar).some(leavesToClient) &&
    !organizers(invitation.object.vcalendar).some(leavesToClient);
  return unfinished
    ? { _tag: 'Change', vcalendar: leftToServer(stored.vcalendar) }
    : { _tag: 'Current' };
};

// An invitation to the series replaces the copy, as it holds every changed
// occurrence too.
const seriesRequest = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
  addresses: ReadonlyArray<string>,
): ImportChange => {
  const before = stored.vcalendar;
  if (!isNewer(invitation.object.master, eventAt(before, 'master'))) {
    return current(invitation, stored);
  }
  const vcalendar = copyOf(invitation.object.vcalendar);
  vcalendar.removeAllProperties('method');
  for (const event of vcalendar.getAllSubcomponents('vevent')) {
    const key = occurrenceKey(event);
    carryOver(
      event,
      eventAt(before, key) ?? eventAt(before, 'master'),
      addresses,
    );
  }
  return { _tag: 'Change', vcalendar };
};

const removeExclusion = (series: ICAL.Component, key: string): void => {
  for (const exdate of series.getAllProperties('exdate')) {
    const kept = exdate.getValues().filter((value) => String(value) !== key);
    if (kept.length === 0) {
      series.removeProperty(exdate);
    } else {
      exdate.setValues(kept);
    }
  }
};

const isExcluded = (series: ICAL.Component, key: string): boolean =>
  series
    .getAllProperties('exdate')
    .some((exdate) =>
      exdate.getValues().some((value) => String(value) === key),
    );

// An invitation to single occurrences adds or replaces them in the copy. An
// occurrence new to the calendar older than the series is one the organizer
// has dropped since.
const occurrenceRequest = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
  addresses: ReadonlyArray<string>,
): ImportChange => {
  const vcalendar = copyOf(stored.vcalendar);
  const series = eventAt(vcalendar, 'master');
  let changed = false;
  for (const incoming of eventsOf(invitation.object)) {
    const key = occurrenceKey(incoming);
    const occurrence = eventAt(vcalendar, key);
    const newer =
      occurrence === undefined
        ? series === undefined || sequenceOf(incoming) >= sequenceOf(series)
        : isNewer(incoming, occurrence);
    if (newer) {
      const event = copyOf(incoming);
      carryOver(event, occurrence ?? series, addresses);
      if (occurrence !== undefined) {
        vcalendar.removeSubcomponent(occurrence);
      }
      vcalendar.addSubcomponent(event);
      if (series !== undefined) {
        removeExclusion(series, key);
      }
      changed = true;
    }
  }
  if (!changed) {
    return current(invitation, stored);
  }
  addTimezones(vcalendar, invitation.object.vcalendar);
  return { _tag: 'Change', vcalendar };
};

const cancelEvent = (event: ICAL.Component, sequence: number): boolean => {
  if (
    String(event.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED'
  ) {
    return false;
  }
  event.updatePropertyWithValue('status', 'CANCELLED');
  event.updatePropertyWithValue(
    'sequence',
    Math.max(sequence, sequenceOf(event)),
  );
  return true;
};

// Excludes a cancelled occurrence from the series, with the time and zone
// its RECURRENCE-ID gives, and drops its changes.
const excludeOccurrence = (
  vcalendar: ICAL.Component,
  series: ICAL.Component,
  cancelled: ICAL.Component,
): boolean => {
  const key = occurrenceKey(cancelled);
  const occurrence = eventAt(vcalendar, key);
  const excluded = isExcluded(series, key);
  if (!excluded) {
    const [, parameters, type, value] = structuredClone(
      cancelled.getFirstProperty('recurrence-id')?.toJSON(),
    );
    series.addProperty(new ICAL.Property(['exdate', parameters, type, value]));
  }
  if (occurrence !== undefined) {
    vcalendar.removeSubcomponent(occurrence);
  }
  return !excluded || occurrence !== undefined;
};

// Cancels one occurrence, unless the copy holds a newer version of it.
const cancelOccurrence = (
  vcalendar: ICAL.Component,
  cancelled: ICAL.Component,
): boolean => {
  const series = eventAt(vcalendar, 'master');
  const occurrence = eventAt(vcalendar, occurrenceKey(cancelled));
  if (occurrence !== undefined && isNewer(occurrence, cancelled)) {
    return false;
  }
  if (series !== undefined) {
    return excludeOccurrence(vcalendar, series, cancelled);
  }
  return (
    occurrence !== undefined && cancelEvent(occurrence, sequenceOf(cancelled))
  );
};

// A cancellation of the meeting marks every event of the copy cancelled, as
// sabre/dav does, unless the copy holds a newer series. One of single
// occurrences removes them from the series, or marks them cancelled when
// the copy holds no series.
const cancel = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
): ImportChange => {
  const vcalendar = copyOf(stored.vcalendar);
  const series = eventAt(vcalendar, 'master');
  const outdated =
    series !== undefined && sequenceOf(series) > invitation.sequence;
  const changes = invitation.object.master.hasProperty('recurrence-id')
    ? eventsOf(invitation.object).map((cancelled) =>
        cancelOccurrence(vcalendar, cancelled),
      )
    : vcalendar
        .getAllSubcomponents('vevent')
        .map((event) => !outdated && cancelEvent(event, invitation.sequence));
  if (!changes.includes(true)) {
    return current(invitation, stored);
  }
  addTimezones(vcalendar, invitation.object.vcalendar);
  return { _tag: 'Change', vcalendar };
};

// What the message does to the copy the user's calendar holds, if any, or
// why it changes nothing there. The user's addresses are in lowercase.
export const importChange = (
  invitation: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
  stored:
    | { readonly href: string; readonly object: CalendarObject }
    | undefined,
): Result.Result<ImportChange, string> => {
  const refusal = importRefusal(invitation, addresses);
  if (refusal !== undefined) {
    return Result.fail(`${invitation.source} ${refusal}`);
  }
  const cancels = invitation.method === 'cancel';
  if (stored === undefined) {
    return Result.succeed(
      cancels
        ? { _tag: 'Absent' }
        : { _tag: 'Create', ics: unansweredCopy(invitation, addresses) },
    );
  }
  const organizer = organizerAddress(invitation.object.master);
  const holder = organizerAddress(stored.object.master);
  if (holder !== organizer) {
    return Result.fail(
      `${stored.href} holds a meeting with the same UID that ${holder ?? 'nobody'} organizes, not ${organizer}, so pim leaves it unchanged`,
    );
  }
  if (cancels) {
    return Result.succeed(cancel(invitation, stored.object));
  }
  return Result.succeed(
    invitation.object.master.hasProperty('recurrence-id')
      ? occurrenceRequest(invitation, stored.object, addresses)
      : seriesRequest(invitation, stored.object, addresses),
  );
};
