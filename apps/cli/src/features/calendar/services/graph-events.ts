import { type DateTime, Effect, Schema } from 'effect';
import { CalendarDataError } from '../errors/errors';
import type { Attendee, Calendar, EventSummary } from '../schemas/calendar';
import {
  addDays,
  type CalendarDate,
  daysBetween,
  formatCalendarDate,
} from './calendar-dates';
import { optional } from './event-fields';
import { formatInstant, localDayWindow } from './ical-time';

// Microsoft Graph leaves out or nulls the properties it has no value for.
export const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

export const GraphCalendar = Schema.Struct({
  id: Schema.String,
  name: nullable(Schema.String),
  hexColor: nullable(Schema.String),
  canEdit: nullable(Schema.Boolean),
  // Such as teamsForBusiness, or unknown when the calendar allows none.
  allowedOnlineMeetingProviders: nullable(Schema.Array(Schema.String)),
});

export type GraphCalendar = typeof GraphCalendar.Type;

const EmailAddress = Schema.Struct({
  name: nullable(Schema.String),
  address: nullable(Schema.String),
});

const DateTimeTimeZone = Schema.Struct({
  dateTime: Schema.String,
  timeZone: nullable(Schema.String),
});

const ResponseStatus = Schema.Struct({ response: nullable(Schema.String) });

export const GraphAttendee = Schema.Struct({
  type: nullable(Schema.String),
  status: nullable(ResponseStatus),
  emailAddress: nullable(EmailAddress),
});

export type GraphAttendee = typeof GraphAttendee.Type;

export const GraphEvent = Schema.Struct({
  id: Schema.String,
  '@odata.etag': nullable(Schema.String),
  iCalUId: nullable(Schema.String),
  subject: nullable(Schema.String),
  start: DateTimeTimeZone,
  end: DateTimeTimeZone,
  isAllDay: nullable(Schema.Boolean),
  isCancelled: nullable(Schema.Boolean),
  location: nullable(Schema.Struct({ displayName: nullable(Schema.String) })),
  organizer: nullable(Schema.Struct({ emailAddress: nullable(EmailAddress) })),
  attendees: nullable(Schema.Array(GraphAttendee)),
  type: nullable(Schema.String),
  originalStart: nullable(Schema.String),
  bodyPreview: nullable(Schema.String),
  body: nullable(
    Schema.Struct({
      contentType: nullable(Schema.String),
      content: nullable(Schema.String),
    }),
  ),
  webLink: nullable(Schema.String),
  seriesMasterId: nullable(Schema.String),
  isOrganizer: nullable(Schema.Boolean),
  // The user's own answer, on a meeting someone else organizes.
  responseStatus: nullable(ResponseStatus),
  isOnlineMeeting: nullable(Schema.Boolean),
  onlineMeetingProvider: nullable(Schema.String),
  onlineMeeting: nullable(Schema.Struct({ joinUrl: nullable(Schema.String) })),
  isReminderOn: nullable(Schema.Boolean),
  reminderMinutesBeforeStart: nullable(Schema.Number),
});

export type GraphEvent = typeof GraphEvent.Type;

export const nonEmpty = (
  value: string | null | undefined,
): string | undefined => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
};

const idOf = (item: unknown): string =>
  typeof item === 'object' &&
  item !== null &&
  'id' in item &&
  typeof item.id === 'string'
    ? item.id
    : 'unknown';

export const decodeGraphEvent = (
  item: unknown,
): Effect.Effect<GraphEvent, CalendarDataError> =>
  Schema.decodeUnknownEffect(GraphEvent)(item).pipe(
    Effect.mapError(
      () =>
        new CalendarDataError({
          href: idOf(item),
          message: `Could not read Outlook event ${idOf(item)}: Microsoft Graph sent it in an unexpected form`,
        }),
    ),
  );

export const graphCalendar = (
  account: string,
  calendar: GraphCalendar,
): Calendar => ({
  account,
  href: calendar.id,
  name: nonEmpty(calendar.name) ?? calendar.id,
  ...optional('color', nonEmpty(calendar.hexColor)),
  ...optional('writable', calendar.canEdit ?? undefined),
});

const dayMs = 86_400_000;
const epoch: CalendarDate = { year: 1970, month: 1, day: 1 };
// Like 2026-10-27T13:00:00.0000000 in a dateTimeTimeZone, or with Z or an
// offset in a DateTimeOffset such as originalStart.
const graphTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u;
const fraction = /\.\d+/u;
const offset = /(?:Z|[+-]\d{2}:\d{2})$/u;

// The instant a Microsoft Graph time stands for. A time without offset is in
// UTC, the zone pim asks Microsoft Graph for.
export const graphInstant = (text: string): number | undefined => {
  if (!graphTime.test(text)) {
    return undefined;
  }
  const iso = text.replace(fraction, '');
  const millis = Date.parse(offset.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(millis) ? undefined : millis;
};

// The day an all-day boundary stands for. Exchange Online and Outlook.com
// keep it as midnight UTC, whatever zone the event was written in, and ignore
// the zone pim asks for. Should Microsoft Graph return it converted from
// another zone, the nearest midnight is still the right day for every zone
// within 12 hours of UTC.
const nearestDate = (millis: number): CalendarDate =>
  addDays(epoch, Math.round(millis / dayMs));

// Like EventSummary's times, with the instants that order events and decide
// whether they overlap a window. All-day events last from local midnight to
// local midnight.
export type GraphSpan = {
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly startMs: number;
  readonly endMs: number;
};

type Timed = Pick<GraphEvent, 'id' | 'start' | 'end' | 'isAllDay'>;

const dataError = (id: string, reason: string) =>
  new CalendarDataError({
    href: id,
    message: `Could not read Outlook event ${id}: ${reason}`,
  });

const allDaySpan = (
  first: CalendarDate,
  exclusiveEnd: CalendarDate,
  local: DateTime.TimeZone,
): GraphSpan => {
  const last =
    daysBetween(first, exclusiveEnd) > 1 ? addDays(exclusiveEnd, -1) : first;
  return {
    start: formatCalendarDate(first),
    end: formatCalendarDate(last),
    allDay: true,
    ...localDayWindow(first, last, local),
  };
};

export const graphSpan = (
  event: Timed,
  local: DateTime.TimeZone,
): Effect.Effect<GraphSpan, CalendarDataError> => {
  const startMs = graphInstant(event.start.dateTime);
  const endMs = graphInstant(event.end.dateTime);
  if (startMs === undefined || endMs === undefined) {
    return Effect.fail(
      dataError(
        event.id,
        `its times ${event.start.dateTime} and ${event.end.dateTime} are not date-times`,
      ),
    );
  }
  if (event.isAllDay === true) {
    return Effect.succeed(
      allDaySpan(nearestDate(startMs), nearestDate(endMs), local),
    );
  }
  const zone = [event.start.timeZone, event.end.timeZone].find(
    (name) => name !== undefined && name !== null && name !== 'UTC',
  );
  return zone === undefined
    ? Effect.succeed({
        start: formatInstant(startMs, local),
        end: formatInstant(endMs, local),
        allDay: false,
        startMs,
        endMs,
      })
    : Effect.fail(
        dataError(
          event.id,
          `Microsoft Graph gave its times in ${zone}, not in UTC as pim asked`,
        ),
      );
};

const occurrenceTypes = new Set(['occurrence', 'exception']);

// The original start of an occurrence of a recurring event, which identifies
// it in its series.
export const graphRecurrenceId = (
  event: Pick<GraphEvent, 'type' | 'originalStart'>,
  allDay: boolean,
  local: DateTime.TimeZone,
): string | undefined => {
  const millis =
    occurrenceTypes.has(event.type ?? '') && nonEmpty(event.originalStart)
      ? graphInstant(event.originalStart ?? '')
      : undefined;
  if (millis === undefined) {
    return undefined;
  }
  return allDay
    ? formatCalendarDate(nearestDate(millis))
    : formatInstant(millis, local);
};

const roles = new Map([
  ['required', 'req-participant'],
  ['optional', 'opt-participant'],
]);

// Microsoft Graph's response of an attendee, as an iCalendar PARTSTAT.
export const graphPartstats = new Map([
  ['accepted', 'accepted'],
  ['tentativelyAccepted', 'tentative'],
  ['declined', 'declined'],
  ['none', 'needs-action'],
  ['notResponded', 'needs-action'],
]);

// Microsoft Graph lists the organizer among the attendees of a meeting with
// the response "organizer"; pim describes them as iCalendar does, as the
// chair who accepted.
export const graphAttendees = (
  event: Pick<GraphEvent, 'attendees'>,
): ReadonlyArray<Attendee> =>
  (event.attendees ?? []).flatMap((attendee) => {
    const email = nonEmpty(attendee.emailAddress?.address);
    if (email === undefined) {
      return [];
    }
    const response = attendee.status?.response ?? '';
    const organizes = response === 'organizer';
    return [
      {
        email,
        ...optional('name', nonEmpty(attendee.emailAddress?.name)),
        ...optional(
          'role',
          organizes ? 'chair' : roles.get(attendee.type ?? ''),
        ),
        ...optional(
          'partstat',
          organizes ? 'accepted' : graphPartstats.get(response),
        ),
      },
    ];
  });

export const graphStatus = (
  event: Pick<GraphEvent, 'isCancelled'>,
): string | undefined => (event.isCancelled === true ? 'cancelled' : undefined);

// bodyPreview holds only the start of the description.
export const graphMentions = (event: GraphEvent, text: string): boolean =>
  [event.subject, event.location?.displayName, event.bodyPreview].some(
    (value) => (value ?? '').toLowerCase().includes(text),
  );

export const graphEventSummary = (
  event: GraphEvent,
  span: GraphSpan,
  context: { readonly account: string; readonly calendar: string },
  local: DateTime.TimeZone,
): EventSummary => {
  const attendees = graphAttendees(event).length;
  return {
    ...context,
    href: event.id,
    uid: nonEmpty(event.iCalUId) ?? event.id,
    summary: nonEmpty(event.subject) ?? '',
    start: span.start,
    end: span.end,
    allDay: span.allDay,
    ...optional('location', nonEmpty(event.location?.displayName)),
    ...optional('status', graphStatus(event)),
    ...optional('recurrenceId', graphRecurrenceId(event, span.allDay, local)),
    ...optional('organizer', nonEmpty(event.organizer?.emailAddress?.address)),
    ...optional('attendees', attendees === 0 ? undefined : attendees),
  };
};
