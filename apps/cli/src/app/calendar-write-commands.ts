import { DateTime, Effect, Option, Result } from 'effect';
import {
  createEvent,
  deleteEvent,
  updateEvent,
} from '../features/calendar/services/calendar-write';
import {
  type EventSpan,
  type EventTime,
  parseEventTime,
  spanBetween,
} from '../features/calendar/services/event-times';
import type { EventReminders } from '../features/calendar/services/event-write';
import {
  parseReminder,
  type ReminderTime,
  reminderFormats,
} from '../features/calendar/services/reminders';
import { AccountConfig } from '../shared/accounts/config';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { type CommandEffect, json } from './command-support';

const timeFormats =
  'a date like 2026-10-28 for an all-day event, or a date-time like 2026-10-28T14:30, read in --time-zone';

const timeZoneFlag = flag.optionalText(
  'zone',
  'IANA time zone of date-times without an offset, like Europe/Berlin (default: the local zone)',
);

const accountFlag = flag.text('email', 'Account from "pim calendar list"');

const zoneOf = (
  command: string,
  value: string | undefined,
): Effect.Effect<DateTime.TimeZone, UsageError> =>
  value === undefined
    ? Effect.succeed(DateTime.zoneMakeLocal())
    : Option.match(DateTime.zoneMakeNamed(value), {
        onNone: () =>
          Effect.fail(
            new UsageError({
              message: `pim ${command}: --time-zone must be an IANA time zone like Europe/Berlin, not "${value}"`,
            }),
          ),
        onSome: Effect.succeed,
      });

const parsed = <A>(
  command: string,
  name: string,
  value: string,
  result: Result.Result<A, string>,
): Effect.Effect<A, UsageError> =>
  Result.match(result, {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(
        new UsageError({
          message: `pim ${command}: --${name} "${value}" ${reason}`,
        }),
      ),
  });

const timeOf = (
  command: string,
  name: string,
  value: string,
  zone: DateTime.TimeZone,
): Effect.Effect<EventTime, UsageError> =>
  parsed(command, name, value, parseEventTime(value, zone));

const remindersOf = (
  command: string,
  values: ReadonlyArray<string>,
  zone: DateTime.TimeZone,
): Effect.Effect<ReadonlyArray<ReminderTime>, UsageError> =>
  Effect.forEach(values, (value) =>
    parsed(command, 'reminder', value, parseReminder(value, zone)),
  );

const spanOf = (
  command: string,
  start: EventTime,
  end: EventTime | undefined,
): Effect.Effect<EventSpan, UsageError> =>
  Result.match(spanBetween(start, end), {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(new UsageError({ message: `pim ${command}: ${reason}` })),
  });

const checkedPair = (
  command: string,
  start: EventTime | undefined,
  end: EventTime | undefined,
): Effect.Effect<void, UsageError> =>
  start === undefined || end === undefined
    ? Effect.void
    : Effect.asVoid(spanOf(command, start, end));

const optionalTimeOf = (
  command: string,
  name: string,
  value: string | undefined,
  zone: DateTime.TimeZone,
): Effect.Effect<EventTime | undefined, UsageError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : timeOf(command, name, value, zone);

const teamsFlag = flag.switch(
  'Add a Teams meeting. Only Outlook calendars of Microsoft 365 work or school accounts offer one, and pim cannot remove it again',
);

const notifyAttendeesFlag = flag.switch(
  'Allow a write that makes the server email the attendees. Pass it only when the user asked to tell them',
);

const nonEmpty = (
  command: string,
  name: string,
  value: string | undefined,
): Effect.Effect<void, UsageError> =>
  value?.trim() === ''
    ? Effect.fail(
        new UsageError({ message: `pim ${command}: --${name} is empty` }),
      )
    : Effect.void;

const create = defineCommand(
  {
    name: 'calendar create',
    summary: 'Create an event',
    description: `Create an event in one calendar. Without --attendee, the event invites and emails no one. With --attendee, the user organizes the event and the server emails each attendee an invitation, so pim requires --notify-attendees and a server that sends invitations itself, as Microsoft does for Outlook calendars. A Teams meeting is an Outlook event with a join link; --teams adds one and emails no one by itself. --start and --end take ${timeFormats}; a date-time with a UTC offset, as other commands print, works too. A timed event needs --end; an all-day event's --end is its last day and defaults to --start. A CalDAV server gets timed events in UTC; Outlook keeps an event's times in --time-zone. --reminder takes ${reminderFormats}. Without --reminder, pim adds no reminder to a CalDAV event, and Outlook gives the event its default reminder. Outlook keeps one reminder, a whole number of minutes before the start, without repeats. Prints the event with its href, when the server returns one its etag, its Teams join link, and, when the server reports it, how it delivered each invitation.`,
    flags: {
      account: accountFlag,
      calendar: flag.text('name|href', 'Calendar from "pim calendar list"'),
      title: flag.text('text', 'Title'),
      start: flag.text('date|date-time', 'Start'),
      end: flag.optionalText(
        'date|date-time',
        'End, or the last day of an all-day event',
      ),
      location: flag.optionalText('text', 'Location'),
      description: flag.optionalText('text', 'Description'),
      attendee: flag.texts('email', 'Address to invite; repeat for more'),
      reminder: flag.texts('when', 'Reminder; repeat for more'),
      notifyAttendees: notifyAttendeesFlag,
      teams: teamsFlag,
      timeZone: timeZoneFlag,
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const command = 'calendar create';
      if (values.notifyAttendees && values.attendee.length === 0) {
        return yield* new UsageError({
          message: `pim ${command}: --notify-attendees notifies no one without --attendee`,
        });
      }
      const zone = yield* zoneOf(command, values.timeZone);
      const start = yield* timeOf(command, 'start', values.start, zone);
      const end = yield* optionalTimeOf(command, 'end', values.end, zone);
      const span = yield* spanOf(command, start, end);
      const reminders = yield* remindersOf(command, values.reminder, zone);
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const event = yield* createEvent(
        account,
        {
          calendar: values.calendar,
          title: values.title,
          span,
          ...(values.location === undefined
            ? {}
            : { location: values.location }),
          ...(values.description === undefined
            ? {}
            : { description: values.description }),
          ...(reminders.length === 0 ? {} : { reminders }),
          attendees: values.attendee,
          notifyAttendees: values.notifyAttendees,
          zone,
          teams: values.teams,
        },
        DateTime.zoneMakeLocal(),
      );
      return json(event);
    }),
);

const targetFlags = {
  account: accountFlag,
  href: flag.text('href', 'Event href from "pim calendar events"'),
  etag: flag.text('etag', 'Etag from "pim calendar get"'),
  series: flag.switch(
    'Allow the change for every occurrence of a recurring event',
  ),
  notifyAttendees: notifyAttendeesFlag,
} as const;

const targetOf = (values: {
  readonly href: string;
  readonly etag: string;
  readonly series: boolean;
  readonly notifyAttendees: boolean;
}) => ({
  href: values.href,
  etag: values.etag,
  series: values.series,
  notifyAttendees: values.notifyAttendees,
});

// The reminders that replace the event's, or none to keep them.
const newReminders = (
  command: string,
  values: {
    readonly reminder: ReadonlyArray<string>;
    readonly noReminders: boolean;
  },
  zone: DateTime.TimeZone,
): Effect.Effect<EventReminders, UsageError> =>
  Effect.gen(function* () {
    if (values.noReminders && values.reminder.length > 0) {
      return yield* new UsageError({
        message: `pim ${command}: pass --reminder or --no-reminders, not both`,
      });
    }
    if (values.noReminders) {
      return { reminders: [] };
    }
    const reminders = yield* remindersOf(command, values.reminder, zone);
    return reminders.length === 0 ? {} : { reminders };
  });

const update = defineCommand(
  {
    name: 'calendar update',
    summary: 'Change an event',
    description: `Change the title, times, location, description, reminders, or attendees of an event, or add a Teams meeting. Pass the etag from "pim calendar get"; if the event changed since, nothing is written. --start and --end take ${timeFormats}. --start alone moves the event and keeps its length. An empty --location or --description removes it. --no-reminders removes every reminder of the event. --reminder replaces them all and takes ${reminderFormats}. Outlook keeps one reminder, a whole number of minutes before the start, without repeats. pim does not move recurring events; in an Outlook calendar, an href from "pim calendar events" names one occurrence, which pim changes alone. A change to a meeting, or to who attends, makes the server email the attendees, so pim makes it only with --notify-attendees, only for meetings the user organizes, and only on a server that sends invitations itself. That includes a change to a meeting's reminders alone. Moving a meeting asks the attendees to reply again. Prints the changed event with its new etag, when the server returns one.`,
    flags: {
      ...targetFlags,
      title: flag.optionalText('text', 'New title'),
      start: flag.optionalText('date|date-time', 'New start'),
      end: flag.optionalText(
        'date|date-time',
        'New end, or the last day of an all-day event',
      ),
      location: flag.optionalText('text', 'New location'),
      description: flag.optionalText('text', 'New description'),
      addAttendee: flag.texts('email', 'Address to invite; repeat for more'),
      removeAttendee: flag.texts(
        'email',
        'Attendee to take off the event; repeat for more',
      ),
      reminder: flag.texts(
        'when',
        'Reminder to replace all others with; repeat for more',
      ),
      noReminders: flag.switch('Remove every reminder'),
      teams: teamsFlag,
      timeZone: timeZoneFlag,
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const command = 'calendar update';
      const { title, location, description, addAttendee, removeAttendee } =
        values;
      if (
        [title, values.start, values.end, location, description].every(
          (value) => value === undefined,
        ) &&
        addAttendee.length + removeAttendee.length + values.reminder.length ===
          0 &&
        !values.noReminders &&
        !values.teams
      ) {
        return yield* new UsageError({
          message: `pim ${command}: pass at least one of --title, --start, --end, --location, --description, --add-attendee, --remove-attendee, --reminder, --no-reminders, or --teams`,
        });
      }
      yield* nonEmpty(command, 'title', title);
      const zone = yield* zoneOf(command, values.timeZone);
      const start = yield* optionalTimeOf(command, 'start', values.start, zone);
      const end = yield* optionalTimeOf(command, 'end', values.end, zone);
      yield* checkedPair(command, start, end);
      const reminders = yield* newReminders(command, values, zone);
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const event = yield* updateEvent(
        account,
        targetOf(values),
        {
          ...(title === undefined ? {} : { title }),
          ...(location === undefined ? {} : { location }),
          ...(description === undefined ? {} : { description }),
          ...(start === undefined ? {} : { start }),
          ...(end === undefined ? {} : { end }),
          ...reminders,
          addAttendees: addAttendee,
          removeAttendees: removeAttendee,
          zone,
          teams: values.teams,
        },
        DateTime.zoneMakeLocal(),
      );
      return json(event);
    }),
);

const remove = defineCommand(
  {
    name: 'calendar delete',
    summary: 'Delete an event',
    description:
      'Delete an event. Pass the etag from "pim calendar get"; if the event changed since, nothing is deleted. A recurring event is deleted with all its occurrences, and only with --series; in an Outlook calendar, an href from "pim calendar events" names one occurrence, which pim deletes alone. Deleting a meeting the user organizes makes the server email the attendees a cancellation, so pim deletes one only with --notify-attendees and only on a server that sends cancellations itself. On a CalDAV server, pim deletes the user\'s copy of a meeting someone else organizes without telling anyone, and refuses to with --notify-attendees, which would tell the organizer the user declined. In an Outlook calendar, pim leaves such a meeting to "pim calendar respond --href", which declines it without telling anyone unless --notify-organizer is passed. Prints the deleted event.',
    flags: targetFlags,
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const deleted = yield* deleteEvent(
        account,
        targetOf(values),
        DateTime.zoneMakeLocal(),
      );
      return json({ deleted });
    }),
);

export const calendarWriteCommands = [create, update, remove];
