import { type DateTime, Effect } from 'effect';
import { EventChangeError } from '../errors/errors';
import type { Reminder } from '../schemas/calendar';
import type { EventReminders } from './event-write';
import type { GraphEvent } from './graph-events';
import { type ReminderTime, relativeWhen, reminderWhen } from './reminders';

// Outlook keeps one reminder per event, a whole number of minutes before its
// start, in these two properties.
type GraphReminder = {
  readonly isReminderOn?: boolean;
  readonly reminderMinutesBeforeStart?: number;
};

const unkept = (
  first: ReminderTime,
  count: number,
  zone: DateTime.TimeZone,
): string => {
  if (count > 1) {
    return `${count} reminders`;
  }
  return first._tag === 'Absolute'
    ? `a reminder at ${reminderWhen(first, zone)}`
    : `a reminder ${reminderWhen(first, zone)}`;
};

// The Microsoft Graph properties for the reminders: none leaves Outlook's
// reminder as it is, an empty list turns it off. Fails for reminders
// Outlook cannot keep.
export const graphReminder = (
  href: string,
  // The zone names an absolute reminder in the error.
  { reminders, zone }: EventReminders & { readonly zone: DateTime.TimeZone },
): Effect.Effect<GraphReminder, EventChangeError> => {
  if (reminders === undefined) {
    return Effect.succeed({});
  }
  const [first, ...rest] = reminders;
  if (first === undefined) {
    return Effect.succeed({ isReminderOn: false });
  }
  if (
    rest.length === 0 &&
    first._tag === 'Relative' &&
    first.related === 'start' &&
    first.minutes <= 0
  ) {
    return Effect.succeed({
      isReminderOn: true,
      reminderMinutesBeforeStart: Math.abs(first.minutes),
    });
  }
  return Effect.fail(
    new EventChangeError({
      href,
      message: `Outlook keeps one reminder per event, a whole number of minutes before the start, like --reminder 15m, so pim cannot set ${unkept(first, reminders.length, zone)}`,
    }),
  );
};

// The reminder of an Outlook event, if it has one.
export const graphReminders = (event: GraphEvent): ReadonlyArray<Reminder> =>
  event.isReminderOn === true &&
  typeof event.reminderMinutesBeforeStart === 'number'
    ? [{ when: relativeWhen(-event.reminderMinutesBeforeStart, 'start') }]
    : [];
