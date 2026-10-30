import type { DateTime } from 'effect';
import ICAL from 'ical.js';
import type { Reminder } from '../schemas/calendar';
import type { CalendarObject } from './event-fields';
import { instantOf } from './ical-time';
import { type ReminderTime, reminderWhen } from './reminders';

const secondsPerMinute = 60;
const minutesPerDay = 1440;

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
    // Seconds round down to the minute, so the reminder printed, written
    // back with --reminder, never goes off later. Adding 0 turns -0 into 0.
    minutes: Math.floor(value.toSeconds() / secondsPerMinute) + 0,
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

// The reminders of an event, from its VALARMs. Display alarms, which show a
// message, leave out the action.
export const remindersOf = (
  component: ICAL.Component,
  local: DateTime.TimeZone,
): ReadonlyArray<Reminder> =>
  component.getAllSubcomponents('valarm').flatMap((alarm) => {
    const time = triggerOf(alarm, local);
    const action = actionOf(alarm);
    return time === undefined
      ? []
      : [
          {
            when: reminderWhen(time, local),
            ...(action === undefined || action === 'display' ? {} : { action }),
          },
        ];
  });

const isAllDay = (component: ICAL.Component): boolean => {
  const start = component.getFirstPropertyValue('dtstart');
  return start instanceof ICAL.Time && start.isDate;
};

// A display alarm that shows the event's title. RELATED=END needs DTEND or
// DURATION (RFC 5545, section 3.8.6.3); without them, a timed event ends at
// its start and an all-day event a day after it, so the trigger is moved to
// the start.
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
    const shift = fromEnd && !hasEnd && isAllDay(component) ? minutesPerDay : 0;
    const trigger = alarm.addPropertyWithValue(
      'trigger',
      ICAL.Duration.fromSeconds((time.minutes + shift) * secondsPerMinute),
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

// The reminders of an event in a form that compares, whatever their order
// and text.
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
