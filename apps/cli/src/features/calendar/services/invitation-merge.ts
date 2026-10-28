import { Result } from 'effect';
import ICAL from 'ical.js';
import { isEmailAddress, organizerAddress } from './event-attendees';
import type { CalendarObject } from './event-fields';
import { addTimezones } from './ical-time';
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
import {
  eventAt,
  exclude,
  excludedSince,
  isNewer,
  keepCancellations,
  removeExclusion,
} from './invitation-revisions';

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

// The copy to change, with the time zones the message uses, so that the
// times of both resolve alike.
const changeable = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
): ICAL.Component => {
  const vcalendar = copyOf(stored.vcalendar);
  addTimezones(vcalendar, invitation.object.vcalendar);
  return vcalendar;
};

// The copy as the message changes it, finished as current() finishes it.
const changed = (
  invitation: ReceivedInvitation,
  vcalendar: ICAL.Component,
): ImportChange => ({
  _tag: 'Change',
  vcalendar: organizers(invitation.object.vcalendar).some(leavesToClient)
    ? vcalendar
    : leftToServer(vcalendar),
});

// Puts a newer series from the organizer in place of the stored one. The
// changed occurrences older than it go unless the message lists them, as
// the organizer sends those that still apply with the series.
const replaceSeries = (
  vcalendar: ICAL.Component,
  invitation: ReceivedInvitation,
  addresses: ReadonlyArray<string>,
): void => {
  const before = eventAt(vcalendar, 'master');
  const series = copyOf(invitation.object.master);
  carryOver(series, before, addresses);
  vcalendar.addSubcomponent(series);
  if (before !== undefined) {
    keepCancellations(before, series);
    vcalendar.removeSubcomponent(before);
  }
  const listed = new Set(eventsOf(invitation.object).map(occurrenceKey));
  for (const event of vcalendar.getAllSubcomponents('vevent')) {
    if (
      event !== series &&
      !listed.has(occurrenceKey(event)) &&
      sequenceOf(event) < sequenceOf(series)
    ) {
      vcalendar.removeSubcomponent(event);
    }
  }
};

type OccurrenceContext = {
  // The series the copy held before the message.
  readonly before: ICAL.Component | undefined;
  // Whether the message replaced the series.
  readonly seriesTaken: boolean;
  readonly addresses: ReadonlyArray<string>;
};

// Whether a changed occurrence is newer than what the copy holds for it: the
// stored version, the cancellation that excluded it, or for an occurrence
// new to the copy, the series it changes.
const occurrenceIsNewer = (
  vcalendar: ICAL.Component,
  incoming: ICAL.Component,
  seriesTaken: boolean,
): boolean => {
  const key = occurrenceKey(incoming);
  const stored = eventAt(vcalendar, key);
  if (stored !== undefined) {
    return isNewer(incoming, stored);
  }
  const series = eventAt(vcalendar, 'master');
  const since = series === undefined ? undefined : excludedSince(series, key);
  if (since !== undefined) {
    return sequenceOf(incoming) > since;
  }
  return (
    series === undefined ||
    seriesTaken ||
    sequenceOf(incoming) >= sequenceOf(series)
  );
};

const takeOccurrence = (
  vcalendar: ICAL.Component,
  incoming: ICAL.Component,
  { before, seriesTaken, addresses }: OccurrenceContext,
): boolean => {
  if (!occurrenceIsNewer(vcalendar, incoming, seriesTaken)) {
    return false;
  }
  const key = occurrenceKey(incoming);
  const stored = eventAt(vcalendar, key);
  const event = copyOf(incoming);
  carryOver(event, stored ?? before, addresses);
  if (stored !== undefined) {
    vcalendar.removeSubcomponent(stored);
  }
  vcalendar.addSubcomponent(event);
  const series = eventAt(vcalendar, 'master');
  if (series !== undefined) {
    removeExclusion(series, key);
  }
  return true;
};

// An invitation replaces each event of the copy that it holds a newer
// version of.
const request = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
  addresses: ReadonlyArray<string>,
): ImportChange => {
  const vcalendar = changeable(invitation, stored);
  const before = eventAt(vcalendar, 'master');
  const { master } = invitation.object;
  const seriesTaken =
    !master.hasProperty('recurrence-id') && isNewer(master, before);
  if (seriesTaken) {
    replaceSeries(vcalendar, invitation, addresses);
  }
  const taken = eventsOf(invitation.object)
    .filter((event) => event.hasProperty('recurrence-id'))
    .map((incoming) =>
      takeOccurrence(vcalendar, incoming, { before, seriesTaken, addresses }),
    );
  return seriesTaken || taken.includes(true)
    ? changed(invitation, vcalendar)
    : current(invitation, stored);
};

// Marks the event cancelled, with the revision of the cancellation when that
// is newer, so that an older invitation does not bring the event back.
const cancelEvent = (
  event: ICAL.Component,
  cancellation: ICAL.Component,
): boolean => {
  const before = event.toString();
  event.updatePropertyWithValue('status', 'CANCELLED');
  if (isNewer(cancellation, event)) {
    event.updatePropertyWithValue('sequence', sequenceOf(cancellation));
    const stamp = cancellation.getFirstPropertyValue('dtstamp');
    if (stamp instanceof ICAL.Time) {
      event.updatePropertyWithValue('dtstamp', stamp.clone());
    }
  }
  return event.toString() !== before;
};

// Excludes a cancelled occurrence from the series, as calendar apps do,
// unless the copy holds a newer version of it or of the series. Without a
// series, the occurrence is marked cancelled.
const cancelOccurrence = (
  vcalendar: ICAL.Component,
  cancelled: ICAL.Component,
): boolean => {
  const key = occurrenceKey(cancelled);
  const series = eventAt(vcalendar, 'master');
  const occurrence = eventAt(vcalendar, key);
  const sequence = sequenceOf(cancelled);
  if (series === undefined) {
    return (
      occurrence !== undefined &&
      sequence >= sequenceOf(occurrence) &&
      cancelEvent(occurrence, cancelled)
    );
  }
  const since = excludedSince(series, key);
  if (
    sequence < sequenceOf(occurrence ?? series) ||
    (since !== undefined && sequence <= since)
  ) {
    return false;
  }
  exclude(series, cancelled);
  if (occurrence !== undefined) {
    vcalendar.removeSubcomponent(occurrence);
  }
  return true;
};

// A cancellation of the meeting marks every event of the copy cancelled, as
// sabre/dav does, unless the copy holds a newer series. One of single
// occurrences cancels only those.
const cancel = (
  invitation: ReceivedInvitation,
  stored: CalendarObject,
): ImportChange => {
  const vcalendar = changeable(invitation, stored);
  const series = eventAt(vcalendar, 'master');
  const { master } = invitation.object;
  const outdated =
    series !== undefined && sequenceOf(series) > invitation.sequence;
  const changes = master.hasProperty('recurrence-id')
    ? eventsOf(invitation.object).map((cancelled) =>
        cancelOccurrence(vcalendar, cancelled),
      )
    : vcalendar
        .getAllSubcomponents('vevent')
        .map((event) => !outdated && cancelEvent(event, master));
  return changes.includes(true)
    ? changed(invitation, vcalendar)
    : current(invitation, stored);
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
  return Result.succeed(request(invitation, stored.object, addresses));
};
