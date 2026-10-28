import { DateTime, Effect, Option, Result } from 'effect';
import {
  createEvent,
  deleteEvent,
  updateEvent,
} from '../features/calendar/services/calendar-write';
import {
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

const optionalTimeOf = (
  command: string,
  name: string,
  value: string | undefined,
  zone: DateTime.TimeZone,
): Effect.Effect<EventTime | undefined, UsageError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : timeOf(command, name, value, zone);

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
    description: `Create an event in one calendar. pim writes no organizer, attendees, or alarms, so creating an event invites and emails no one. --start and --end take ${timeFormats}; a date-time with a UTC offset, as other commands print, works too. A timed event needs --end; an all-day event's --end is its last day and defaults to --start. Timed events are stored in UTC. Prints the event with its href and, when the server returns one, its etag.`,
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
      timeZone: timeZoneFlag,
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const command = 'calendar create';
      const zone = yield* zoneOf(command, values.timeZone);
      const start = yield* timeOf(command, 'start', values.start, zone);
      const end = yield* optionalTimeOf(command, 'end', values.end, zone);
      const span = spanBetween(start, end);
      if (Result.isFailure(span)) {
        return yield* new UsageError({
          message: `pim ${command}: ${span.failure}`,
        });
      }
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const event = yield* createEvent(
        account,
        {
          calendar: values.calendar,
          title: values.title,
          span: span.success,
          ...(values.location === undefined
            ? {}
            : { location: values.location }),
          ...(values.description === undefined
            ? {}
            : { description: values.description }),
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
} as const;

const update = defineCommand(
  {
    name: 'calendar update',
    summary: 'Change an event',
    description: `Change the title, times, location, or description of an event. Pass the etag from "pim calendar get"; if the event changed since, nothing is written. --start and --end take ${timeFormats}. --start alone moves the event and keeps its length. An empty --location or --description removes it. pim refuses events with attendees other than the organizer, because a change could email them, and does not move recurring events. Prints the changed event with its new etag, when the server returns one.`,
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
      timeZone: timeZoneFlag,
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const command = 'calendar update';
      const { title, location, description } = values;
      if (
        [title, values.start, values.end, location, description].every(
          (value) => value === undefined,
        )
      ) {
        return yield* new UsageError({
          message: `pim ${command}: pass at least one of --title, --start, --end, --location, or --description`,
        });
      }
      yield* nonEmpty(command, 'title', title);
      const zone = yield* zoneOf(command, values.timeZone);
      const start = yield* optionalTimeOf(command, 'start', values.start, zone);
      const end = yield* optionalTimeOf(command, 'end', values.end, zone);
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const event = yield* updateEvent(
        account,
        { href: values.href, etag: values.etag, series: values.series },
        {
          ...(title === undefined ? {} : { title }),
          ...(location === undefined ? {} : { location }),
          ...(description === undefined ? {} : { description }),
          ...(start === undefined ? {} : { start }),
          ...(end === undefined ? {} : { end }),
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
      'Delete an event. Pass the etag from "pim calendar get"; if the event changed since, nothing is deleted. A recurring event is deleted with all its occurrences, and only with --series. pim refuses events with attendees other than the organizer, because deleting one could email them. Prints the deleted event.',
    flags: targetFlags,
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const deleted = yield* deleteEvent(
        account,
        { href: values.href, etag: values.etag, series: values.series },
        DateTime.zoneMakeLocal(),
      );
      return json({ deleted });
    }),
);

export const calendarWriteCommands = [create, update, remove];
