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

const timeOf = (
  command: string,
  name: string,
  value: string,
  zone: DateTime.TimeZone,
): Effect.Effect<EventTime, UsageError> =>
  Result.match(parseEventTime(value, zone), {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(
        new UsageError({
          message: `pim ${command}: --${name} "${value}" ${reason}`,
        }),
      ),
  });

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
    description: `Create an event in one calendar. Without --attendee, pim writes no organizer, attendees, or alarms, so the event invites and emails no one. With --attendee, the user organizes the event and the server emails each attendee an invitation, so pim requires --notify-attendees and a server that sends invitations itself. --start and --end take ${timeFormats}; a date-time with a UTC offset, as other commands print, works too. A timed event needs --end; an all-day event's --end is its last day and defaults to --start. Timed events are stored in UTC. Prints the event with its href, when the server returns one its etag, and, when the server reports it, how it delivered each invitation. pim writes only to the calendars of accounts with a dav table; it only reads Outlook calendars.`,
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
      notifyAttendees: notifyAttendeesFlag,
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
          attendees: values.attendee,
          notifyAttendees: values.notifyAttendees,
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

const update = defineCommand(
  {
    name: 'calendar update',
    summary: 'Change an event',
    description: `Change the title, times, location, description, or attendees of an event. Pass the etag from "pim calendar get"; if the event changed since, nothing is written. --start and --end take ${timeFormats}. --start alone moves the event and keeps its length. An empty --location or --description removes it. pim does not move recurring events. A change to a meeting, or to who attends, makes the server email the attendees, so pim makes it only with --notify-attendees, only for meetings the user organizes, and only on a server that sends invitations itself. Moving a meeting asks the attendees to reply again. Prints the changed event with its new etag, when the server returns one. pim only reads Outlook events.`,
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
        addAttendee.length + removeAttendee.length === 0
      ) {
        return yield* new UsageError({
          message: `pim ${command}: pass at least one of --title, --start, --end, --location, --description, --add-attendee, or --remove-attendee`,
        });
      }
      yield* nonEmpty(command, 'title', title);
      const zone = yield* zoneOf(command, values.timeZone);
      const start = yield* optionalTimeOf(command, 'start', values.start, zone);
      const end = yield* optionalTimeOf(command, 'end', values.end, zone);
      yield* checkedPair(command, start, end);
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
          addAttendees: addAttendee,
          removeAttendees: removeAttendee,
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
      'Delete an event. Pass the etag from "pim calendar get"; if the event changed since, nothing is deleted. A recurring event is deleted with all its occurrences, and only with --series. Deleting a meeting the user organizes makes the server email the attendees a cancellation, so pim deletes one only with --notify-attendees and only on a server that sends cancellations itself. pim deletes the user\'s copy of a meeting someone else organizes without telling anyone, and refuses to with --notify-attendees, which would tell the organizer the user declined; "pim calendar respond" declines. pim only reads Outlook events. Prints the deleted event.',
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
