import type { DateTime } from 'effect';
import { Result } from 'effect';
import ICAL from 'ical.js';
import { addDays, type CalendarDate, daysBetween } from './calendar-dates';
import {
  addAttendees,
  attendeeChanges,
  changeAttendees,
  type Organizer,
  resetReplies,
  setOrganizer,
} from './event-attendees';
import { type CalendarObject, spanOf, text } from './event-fields';
import { changedSpan, type EventSpan, type EventTime } from './event-times';
import { registerIanaZones } from './ical-time';

export const productId = '-//pim//EN';

// The text fields pim writes. An empty location or description removes it.
export type EventText = {
  readonly title?: string;
  readonly location?: string;
  readonly description?: string;
};

export type Invitation = {
  readonly organizer: Organizer;
  readonly attendees: ReadonlyArray<string>;
};

export type NewEvent = EventText & {
  readonly uid: string;
  readonly title: string;
  readonly span: EventSpan;
  readonly invitation?: Invitation;
};

export type EventChanges = EventText & {
  readonly start?: EventTime;
  readonly end?: EventTime;
  readonly addAttendees?: ReadonlyArray<string>;
  readonly removeAttendees?: ReadonlyArray<string>;
};

const utcTime = (ms: number): ICAL.Time =>
  ICAL.Time.fromJSDate(new Date(ms), true);

const dateTime = (date: CalendarDate): ICAL.Time =>
  ICAL.Time.fromData({ ...date, isDate: true });

const dateOf = (time: ICAL.Time): CalendarDate => ({
  year: time.year,
  month: time.month,
  day: time.day,
});

// Times are written in UTC, so the event needs no VTIMEZONE; DTEND of an
// all-day event is the day after its last day, and a zero-length event has
// none, since DTEND must be later than DTSTART.
const setSpan = (component: ICAL.Component, span: EventSpan): void => {
  for (const name of ['dtstart', 'dtend', 'duration']) {
    component.removeAllProperties(name);
  }
  if (span._tag === 'Days') {
    component.addPropertyWithValue('dtstart', dateTime(span.first));
    component.addPropertyWithValue('dtend', dateTime(addDays(span.last, 1)));
  } else {
    component.addPropertyWithValue('dtstart', utcTime(span.startMs));
    if (span.endMs !== span.startMs) {
      component.addPropertyWithValue('dtend', utcTime(span.endMs));
    }
  }
};

const textProperties = {
  title: 'summary',
  location: 'location',
  description: 'description',
} as const;

// Replaces the property rather than its value, so parameters that describe
// the old text, such as ALTREP, go with it. Outlook's HTML copy of the
// description would otherwise win over the new one.
const setText = (
  component: ICAL.Component,
  name: string,
  value: string,
): void => {
  component.removeAllProperties(name);
  if (name === 'description') {
    component.removeAllProperties('x-alt-desc');
  }
  if (value !== '') {
    component.addPropertyWithValue(name, value);
  }
};

// The iCalendar text of an event without alarms. Without an invitation it
// has no organizer or attendees, so storing it invites no one.
export const newEventIcs = (event: NewEvent, nowMs: number): string => {
  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.addPropertyWithValue('version', '2.0');
  vcalendar.addPropertyWithValue('prodid', productId);
  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', event.uid);
  for (const name of ['dtstamp', 'created', 'last-modified']) {
    vevent.addPropertyWithValue(name, utcTime(nowMs));
  }
  setSpan(vevent, event.span);
  for (const [field, name] of Object.entries(textProperties)) {
    const value = event[field as keyof EventText];
    if (value !== undefined) {
      setText(vevent, name, value);
    }
  }
  if (event.invitation !== undefined) {
    setOrganizer(vevent, event.invitation.organizer);
    addAttendees(vevent, event.invitation.attendees);
  }
  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
};

export const isRecurring = ({ master, overrides }: CalendarObject): boolean =>
  master.hasProperty('rrule') ||
  master.hasProperty('rdate') ||
  overrides.length > 0;

const currentSpan = (
  master: ICAL.Component,
  local: DateTime.TimeZone,
): EventSpan => {
  const span = spanOf(new ICAL.Event(master), local);
  if (!span.start.isDate) {
    return { _tag: 'Times', startMs: span.startMs, endMs: span.endMs };
  }
  const first = dateOf(span.start);
  const last = addDays(dateOf(span.end), -1);
  return {
    _tag: 'Days',
    first,
    last: daysBetween(first, last) < 0 ? first : last,
  };
};

const sameSpan = (a: EventSpan, b: EventSpan): boolean =>
  a._tag === 'Days' && b._tag === 'Days'
    ? daysBetween(a.first, b.first) === 0 && daysBetween(a.last, b.last) === 0
    : a._tag === 'Times' &&
      b._tag === 'Times' &&
      a.startMs === b.startMs &&
      a.endMs === b.endMs;

const bumpSequence = (component: ICAL.Component): void => {
  const sequence = Number(component.getFirstPropertyValue('sequence') ?? 0);
  component.updatePropertyWithValue(
    'sequence',
    Number.isSafeInteger(sequence) ? sequence + 1 : 1,
  );
};

const touch = (component: ICAL.Component, nowMs: number): void => {
  for (const name of ['dtstamp', 'last-modified']) {
    component.updatePropertyWithValue(name, utcTime(nowMs));
  }
};

// Applies the text changes to the series and to each changed occurrence
// that still had the series' old text, and returns the events it changed.
const applyText = (
  { master, overrides }: CalendarObject,
  changes: EventText,
): Set<ICAL.Component> => {
  const changed = new Set<ICAL.Component>();
  for (const [field, name] of Object.entries(textProperties)) {
    const value = changes[field as keyof EventText];
    const old = text(master, name);
    const targets =
      value === undefined
        ? []
        : [
            master,
            ...overrides.filter((override) => text(override, name) === old),
          ];
    for (const component of targets) {
      setText(component, name, value ?? '');
      changed.add(component);
    }
  }
  return changed;
};

// Changes the event in place. Fails with the reason when pim does not make
// the change, such as moving a recurring series. Moving an event asks its
// attendees to reply again.
export const applyChanges = (
  object: CalendarObject,
  changes: EventChanges,
  local: DateTime.TimeZone,
  nowMs: number,
): Result.Result<void, string> => {
  const { master, vcalendar } = object;
  const movesTime = changes.start !== undefined || changes.end !== undefined;
  // A changed occurrence stored without its series does not move either.
  if (
    movesTime &&
    (isRecurring(object) || master.hasProperty('recurrence-id'))
  ) {
    return Result.fail(
      'pim does not move recurring events; change the times of the series or an occurrence in a calendar app',
    );
  }
  registerIanaZones(vcalendar);
  const current = currentSpan(master, local);
  const span = movesTime
    ? changedSpan(current, changes.start, changes.end)
    : undefined;
  if (span !== undefined && Result.isFailure(span)) {
    return Result.fail(span.failure);
  }
  const attendees = attendeeChanges(
    object,
    changes.addAttendees ?? [],
    changes.removeAttendees ?? [],
  );
  if (Result.isFailure(attendees)) {
    return Result.fail(attendees.failure);
  }
  const changed = applyText(object, changes);
  if (span !== undefined && !sameSpan(span.success, current)) {
    setSpan(master, span.success);
    bumpSequence(master);
    resetReplies(master);
    changed.add(master);
  }
  for (const component of changeAttendees(object, attendees.success)) {
    changed.add(component);
  }
  for (const component of changed) {
    touch(component, nowMs);
  }
  return Result.void;
};
