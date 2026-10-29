import { type DateTime, Effect, Schema } from 'effect';
import { convert } from 'html-to-text';
import type { CalendarDataError } from '../errors/errors';
import type { Attendee, EventChange, EventDetail } from '../schemas/calendar';
import { daysBetween, parseCalendarDate } from './calendar-dates';
import { optional } from './event-fields';
import {
  decodeGraphEvent,
  GraphEvent,
  type GraphSpan,
  graphAttendees,
  graphPartstats,
  graphRecurrenceId,
  graphSpan,
  graphStatus,
  nonEmpty,
  nullable,
} from './graph-events';
import { formatUtcStamp } from './ical-time';

const RecurrencePattern = Schema.Struct({
  type: Schema.String,
  interval: nullable(Schema.Number),
  month: nullable(Schema.Number),
  dayOfMonth: nullable(Schema.Number),
  daysOfWeek: nullable(Schema.Array(Schema.String)),
  firstDayOfWeek: nullable(Schema.String),
  index: nullable(Schema.String),
});

type RecurrencePattern = typeof RecurrencePattern.Type;

const RecurrenceRange = Schema.Struct({
  type: Schema.String,
  startDate: nullable(Schema.String),
  endDate: nullable(Schema.String),
  numberOfOccurrences: nullable(Schema.Number),
});

type RecurrenceRange = typeof RecurrenceRange.Type;

export const PatternedRecurrence = Schema.Struct({
  pattern: RecurrencePattern,
  range: RecurrenceRange,
});

type PatternedRecurrence = typeof PatternedRecurrence.Type;

const { id, subject, start, end, isAllDay, location, attendees } =
  GraphEvent.fields;

// A series master, with what pim compares its exceptions with.
export const GraphSeries = Schema.Struct({
  id,
  subject,
  start,
  end,
  isAllDay,
  location,
  attendees,
  recurrence: nullable(PatternedRecurrence),
  cancelledOccurrences: nullable(Schema.Array(Schema.String)),
  exceptionOccurrences: nullable(Schema.Array(Schema.Unknown)),
});

export type GraphSeries = typeof GraphSeries.Type;

const frequencies = new Map([
  ['daily', 'DAILY'],
  ['weekly', 'WEEKLY'],
  ['absoluteMonthly', 'MONTHLY'],
  ['relativeMonthly', 'MONTHLY'],
  ['absoluteYearly', 'YEARLY'],
  ['relativeYearly', 'YEARLY'],
]);

const weekdays = new Map([
  ['sunday', 'SU'],
  ['monday', 'MO'],
  ['tuesday', 'TU'],
  ['wednesday', 'WE'],
  ['thursday', 'TH'],
  ['friday', 'FR'],
  ['saturday', 'SA'],
]);

// Which of the matching days in the month a relative pattern means.
// Microsoft Graph defaults to the first.
const positions = new Map([
  ['first', '1'],
  ['second', '2'],
  ['third', '3'],
  ['fourth', '4'],
  ['last', '-1'],
]);

const part = (
  name: string,
  value: string | number | null | undefined,
): ReadonlyArray<string> =>
  value === undefined || value === null || value === ''
    ? []
    : [`${name}=${value}`];

const byDay = (pattern: RecurrencePattern): string =>
  (pattern.daysOfWeek ?? [])
    .flatMap((day) => weekdays.get(day.toLowerCase()) ?? [])
    .join(',');

const patternParts = (pattern: RecurrencePattern): ReadonlyArray<string> => {
  const days = part('BYDAY', byDay(pattern));
  const position = part('BYSETPOS', positions.get(pattern.index ?? 'first'));
  const month = part('BYMONTH', pattern.month);
  const dayOfMonth = part('BYMONTHDAY', pattern.dayOfMonth);
  switch (pattern.type) {
    case 'weekly':
      // The first day of the week decides which weeks a rule that skips
      // weeks matches.
      return (pattern.interval ?? 1) > 1
        ? [
            ...days,
            ...part(
              'WKST',
              weekdays.get(pattern.firstDayOfWeek?.toLowerCase() ?? ''),
            ),
          ]
        : days;
    case 'absoluteMonthly':
      return dayOfMonth;
    case 'relativeMonthly':
      return [...days, ...position];
    case 'absoluteYearly':
      return [...month, ...dayOfMonth];
    case 'relativeYearly':
      return [...month, ...days, ...position];
    default:
      return [];
  }
};

const dayMs = 86_400_000;
const untilMarginMs = 43_200_000;

// Microsoft Graph ends a series on a day in the series' time zone. An all-day
// series keeps that day as UNTIL. A timed one needs an instant, which pim puts
// 12 hours after the series' time of day on that day: past the last
// occurrence even when daylight saving time moved it, and before the next.
const until = (
  range: RecurrenceRange,
  first: Pick<GraphSpan, 'allDay' | 'startMs'>,
): string | undefined => {
  const from = parseCalendarDate(range.startDate ?? '');
  const to = parseCalendarDate(range.endDate ?? '');
  if (to === undefined) {
    return undefined;
  }
  // Microsoft Graph always sends startDate; the date alone still ends the
  // series without it.
  return first.allDay || from === undefined
    ? range.endDate?.replaceAll('-', '')
    : formatUtcStamp(
        first.startMs + daysBetween(from, to) * dayMs + untilMarginMs,
      );
};

const rangeParts = (
  range: RecurrenceRange,
  first: Pick<GraphSpan, 'allDay' | 'startMs'>,
): ReadonlyArray<string> => {
  switch (range.type) {
    case 'endDate':
      return part('UNTIL', until(range, first));
    case 'numbered':
      return part('COUNT', range.numberOfOccurrences);
    default:
      return [];
  }
};

// The iCalendar RRULE of a Microsoft Graph recurrence whose series starts at
// first, or nothing for a pattern pim does not know.
export const recurrenceRule = (
  { pattern, range }: PatternedRecurrence,
  first: Pick<GraphSpan, 'allDay' | 'startMs'>,
): string | undefined => {
  const frequency = frequencies.get(pattern.type);
  if (frequency === undefined) {
    return undefined;
  }
  return [
    `FREQ=${frequency}`,
    ...((pattern.interval ?? 1) > 1 ? part('INTERVAL', pattern.interval) : []),
    ...patternParts(pattern),
    ...rangeParts(range, first),
  ].join(';');
};

// Microsoft Graph names a cancelled occurrence like OID.<series id>.2026-10-27,
// with the day the occurrence was due.
const cancelledDay = /\.(?<day>\d{4}-\d{2}-\d{2})$/u;

export const cancelledDays = (
  ids: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  ids.flatMap((occurrence) => cancelledDay.exec(occurrence)?.groups?.day ?? []);

// Who attends and how they answered, to compare an occurrence with its
// series.
const attendeeSet = (list: ReadonlyArray<Attendee>): string =>
  [
    ...new Set(
      list.map(
        (attendee) =>
          `${attendee.email.toLowerCase()}=${attendee.partstat ?? 'needs-action'}`,
      ),
    ),
  ]
    .toSorted()
    .join(' ');

const differs = (
  value: string | undefined,
  inSeries: string | undefined,
): string | undefined => (value === inSeries ? undefined : value);

const changeOf = (
  exception: GraphEvent,
  span: GraphSpan,
  series: GraphSeries,
  local: DateTime.TimeZone,
): EventChange => {
  const changedAttendees = graphAttendees(exception);
  return {
    recurrenceId:
      graphRecurrenceId(exception, span.allDay, local) ?? span.start,
    start: span.start,
    end: span.end,
    ...optional(
      'summary',
      differs(nonEmpty(exception.subject), nonEmpty(series.subject)),
    ),
    ...optional('status', graphStatus(exception)),
    ...optional(
      'location',
      differs(
        nonEmpty(exception.location?.displayName),
        nonEmpty(series.location?.displayName),
      ),
    ),
    ...optional(
      'attendees',
      attendeeSet(changedAttendees) === attendeeSet(graphAttendees(series))
        ? undefined
        : changedAttendees,
    ),
  };
};

// The rule of a series, the days it skips, and the occurrences that differ
// from it, all from the one request for its series master.
export const seriesRecurrence = (
  series: GraphSeries,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail['recurrence'], CalendarDataError> =>
  Effect.gen(function* () {
    if (series.recurrence === undefined || series.recurrence === null) {
      return;
    }
    const first = yield* graphSpan(series, local);
    const changed = yield* Effect.forEach(
      series.exceptionOccurrences ?? [],
      (item) =>
        decodeGraphEvent(item).pipe(
          Effect.flatMap((exception) =>
            graphSpan(exception, local).pipe(
              Effect.map((span) => changeOf(exception, span, series, local)),
            ),
          ),
        ),
    );
    return {
      ...optional('rule', recurrenceRule(series.recurrence, first)),
      excluded: cancelledDays(series.cancelledOccurrences ?? []),
      changed: changed.toSorted((left, right) =>
        left.recurrenceId.localeCompare(right.recurrenceId),
      ),
    };
  });

// pim asks for the description as text; this covers a server that sends
// HTML anyway.
const description = (body: GraphEvent['body']): string | undefined => {
  const content = nonEmpty(body?.content);
  return content !== undefined && body?.contentType?.toLowerCase() === 'html'
    ? nonEmpty(
        convert(content, {
          wordwrap: false,
          selectors: [{ selector: 'img', format: 'skip' }],
        }),
      )
    : content;
};

const organizerOf = (event: GraphEvent): EventDetail['organizer'] => {
  const email = nonEmpty(event.organizer?.emailAddress?.address);
  return email === undefined
    ? undefined
    : {
        email,
        ...optional('name', nonEmpty(event.organizer?.emailAddress?.name)),
      };
};

const onlineMeetingOf = (event: GraphEvent): EventDetail['onlineMeeting'] =>
  event.isOnlineMeeting === true
    ? {
        provider: nonEmpty(event.onlineMeetingProvider) ?? 'unknown',
        ...optional('joinUrl', nonEmpty(event.onlineMeeting?.joinUrl)),
      }
    : undefined;

// On a meeting someone else organizes, Microsoft Graph keeps the user's own
// answer apart from the attendees, whose answers it may not know.
const withOwnAnswer = (
  event: GraphEvent,
  account: string,
  listed: ReadonlyArray<Attendee>,
): ReadonlyArray<Attendee> => {
  const own = graphPartstats.get(event.responseStatus?.response ?? '');
  if (event.isOrganizer !== false || own === undefined) {
    return listed;
  }
  const email = account.toLowerCase();
  return listed.map((attendee) =>
    attendee.email.toLowerCase() === email
      ? { ...attendee, partstat: own }
      : attendee,
  );
};

export const graphEventDetail = (
  event: GraphEvent,
  span: GraphSpan,
  context: {
    readonly account: string;
    readonly recurrence: EventDetail['recurrence'];
  },
): EventDetail => ({
  account: context.account,
  href: event.id,
  ...optional('etag', nonEmpty(event['@odata.etag'])),
  ...optional(
    'seriesHref',
    event.type === 'seriesMaster' ? undefined : nonEmpty(event.seriesMasterId),
  ),
  uid: nonEmpty(event.iCalUId) ?? event.id,
  summary: nonEmpty(event.subject) ?? '',
  start: span.start,
  end: span.end,
  allDay: span.allDay,
  ...optional('location', nonEmpty(event.location?.displayName)),
  ...optional('description', description(event.body)),
  ...optional('url', nonEmpty(event.webLink)),
  ...optional('onlineMeeting', onlineMeetingOf(event)),
  ...optional('status', graphStatus(event)),
  ...optional('organizer', organizerOf(event)),
  attendees: withOwnAnswer(event, context.account, graphAttendees(event)),
  ...optional('recurrence', context.recurrence),
});
