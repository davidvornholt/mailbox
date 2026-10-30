import type { DateTime } from 'effect';
import ICAL from 'ical.js';
import type { Reminder } from '../schemas/calendar';
import type { CalendarObject } from './event-fields';
import { instantOf } from './ical-time';
import { type ReminderTime, reminderWhen, secondsPerMinute } from './reminders';

const msPerSecond = 1000;
const secondsPerHour = 3600;
const secondsPerDay = 86_400;
const daysPerWeek = 7;

// The days and seconds of a duration, apart: days are nominal and seconds
// exact (RFC 5545, section 3.3.6).
const partsOf = (
  duration: ICAL.Duration,
): { readonly days: number; readonly seconds: number } => {
  const sign = duration.isNegative ? -1 : 1;
  const seconds =
    duration.hours * secondsPerHour +
    duration.minutes * secondsPerMinute +
    duration.seconds;
  return {
    // Adding 0 turns -0 into 0.
    days: sign * (duration.weeks * daysPerWeek + duration.days) + 0,
    seconds: sign * seconds + 0,
  };
};

// The time a VALARM's TRIGGER stands for, or none when it has no trigger.
const triggerOf = (
  alarm: ICAL.Component,
  local: DateTime.TimeZone,
): ReminderTime | undefined => {
  const property = alarm.getFirstProperty('trigger');
  const value = property?.getFirstValue();
  if (property === null || property === undefined) {
    return;
  }
  if (value instanceof ICAL.Time) {
    const tzid = property.getParameter('tzid');
    return {
      _tag: 'Absolute',
      ms: instantOf(value, typeof tzid === 'string' ? tzid : undefined, local),
    };
  }
  if (!(value instanceof ICAL.Duration)) {
    return;
  }
  const related = property.getParameter('related');
  return {
    _tag: 'Relative',
    ...partsOf(value),
    related:
      typeof related === 'string' && related.toUpperCase() === 'END'
        ? 'end'
        : 'start',
  };
};

// event-fields reads events with this module, so this one reads text
// properties itself rather than import its helper.
const textOf = (
  component: ICAL.Component,
  name: string,
): string | undefined => {
  const value = component.getFirstPropertyValue(name);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
};

const actionOf = (alarm: ICAL.Component): string | undefined =>
  textOf(alarm, 'action')?.toLowerCase();

// The times an alarm goes off: its trigger, then REPEAT more times, each
// DURATION after the one before (RFC 5545, section 3.8.6.2). No one
// duration holds days one way and seconds the other, like 5 minutes after a
// day before the start, so such a time keeps only the part that points
// earlier and goes off no later.
const firingsOf = (
  alarm: ICAL.Component,
  local: DateTime.TimeZone,
): ReadonlyArray<ReminderTime> => {
  const first = triggerOf(alarm, local);
  const repeat = Number(alarm.getFirstPropertyValue('repeat'));
  const delay = alarm.getFirstPropertyValue('duration');
  if (first === undefined) {
    return [];
  }
  if (!(delay instanceof ICAL.Duration && repeat > 0)) {
    return [first];
  }
  const step = partsOf(delay);
  return Array.from({ length: repeat + 1 }, (_, count): ReminderTime => {
    if (first._tag === 'Absolute') {
      // An absolute trigger is in UTC, where a day lasts 24 hours.
      const seconds = step.days * secondsPerDay + step.seconds;
      return { _tag: 'Absolute', ms: first.ms + count * seconds * msPerSecond };
    }
    const days = first.days + count * step.days;
    const seconds = first.seconds + count * step.seconds;
    const mixed = days * seconds < 0;
    return {
      ...first,
      days: mixed ? Math.min(days, 0) : days,
      seconds: mixed ? Math.min(seconds, 0) : seconds,
    };
  });
};

// The reminders of an event, one for each time its VALARMs go off. Display
// alarms, which show a message, leave out the action.
export const remindersOf = (
  component: ICAL.Component,
  local: DateTime.TimeZone,
): ReadonlyArray<Reminder> =>
  component.getAllSubcomponents('valarm').flatMap((alarm) => {
    const action = actionOf(alarm);
    return firingsOf(alarm, local).map((time) => ({
      when: reminderWhen(time, local),
      ...(action === undefined || action === 'display' ? {} : { action }),
    }));
  });

const isAllDay = (component: ICAL.Component): boolean => {
  const start = component.getFirstPropertyValue('dtstart');
  return start instanceof ICAL.Time && start.isDate;
};

// A duration with the days and the hours, minutes, and seconds apart, as
// ICAL.Duration.fromSeconds would turn 24 hours into a day.
const durationOf = (days: number, seconds: number): ICAL.Duration => {
  const exact = Math.abs(seconds);
  return ICAL.Duration.fromData({
    isNegative: days < 0 || seconds < 0,
    days: Math.abs(days),
    hours: Math.floor(exact / secondsPerHour),
    minutes: Math.floor((exact % secondsPerHour) / secondsPerMinute),
    seconds: exact % secondsPerMinute,
  });
};

// A display alarm that shows the event's title. RELATED=END needs DTEND or
// DURATION (RFC 5545, section 3.8.6.3); without them, a timed event ends at
// its start and an all-day event a day after it, so the trigger is moved to
// the start. A day after the start and some hours before it fit in no one
// duration, so such a trigger counts the day as 24 hours.
const alarmOf = (component: ICAL.Component, time: ReminderTime) => {
  const alarm = new ICAL.Component('valarm');
  alarm.addPropertyWithValue('action', 'DISPLAY');
  if (time._tag === 'Absolute') {
    alarm.addPropertyWithValue(
      'trigger',
      ICAL.Time.fromJSDate(new Date(time.ms), true),
    );
  } else {
    const hasEnd =
      component.hasProperty('dtend') || component.hasProperty('duration');
    const fromEnd = time.related === 'end';
    const days =
      time.days + (fromEnd && !hasEnd && isAllDay(component) ? 1 : 0);
    const trigger = alarm.addPropertyWithValue(
      'trigger',
      days > 0 && time.seconds < 0
        ? durationOf(0, days * secondsPerDay + time.seconds)
        : durationOf(days, time.seconds),
    );
    if (fromEnd && hasEnd) {
      trigger.setParameter('related', 'END');
    }
  }
  alarm.addPropertyWithValue(
    'description',
    textOf(component, 'summary') ?? 'Reminder',
  );
  return alarm;
};

// Replaces the event's alarms with the reminders. Call it after setting the
// event's times and title, which the alarms depend on.
export const setAlarms = (
  component: ICAL.Component,
  reminders: ReadonlyArray<ReminderTime>,
): void => {
  component.removeAllSubcomponents('valarm');
  for (const time of reminders) {
    component.addSubcomponent(alarmOf(component, time));
  }
};

// The alarms of an event in a form that compares to the second, whatever
// their order and text.
const alarmsKey = (
  component: ICAL.Component,
  local: DateTime.TimeZone,
): string =>
  component
    .getAllSubcomponents('valarm')
    .map((alarm) =>
      JSON.stringify([actionOf(alarm), triggerOf(alarm, local) ?? null]),
    )
    .sort()
    .join('\n');

// Replaces the reminders of the series and of each changed occurrence that
// still had the series' old ones, and returns the events it changed. Without
// reminders, it changes none.
export const replaceAlarms = (
  { master, overrides }: CalendarObject,
  reminders: ReadonlyArray<ReminderTime> | undefined,
  local: DateTime.TimeZone,
): ReadonlyArray<ICAL.Component> => {
  if (reminders === undefined) {
    return [];
  }
  const old = alarmsKey(master, local);
  const targets = [
    master,
    ...overrides.filter((override) => alarmsKey(override, local) === old),
  ];
  for (const component of targets) {
    setAlarms(component, reminders);
  }
  return targets;
};
