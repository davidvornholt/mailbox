import { type DateTime, Effect } from 'effect';
import ICAL from 'ical.js';
import { CalendarDataError } from '../errors/errors';
import type {
  Attendee,
  EventChange,
  EventDetail,
  EventSummary,
} from '../schemas/calendar';
import { formatDate, formatInstant, instantOf } from './ical-time';
import { type Occurrence, tzidOf } from './occurrences';

// One calendar object: its VCALENDAR, and the event series it describes.
// The series is the VEVENT without a RECURRENCE-ID; the overrides change
// single occurrences of it.
export type CalendarObject = {
  readonly vcalendar: ICAL.Component;
  readonly master: ICAL.Component;
  readonly overrides: ReadonlyArray<ICAL.Component>;
};

export const parseCalendar = (
  href: string,
  ics: string,
): Effect.Effect<CalendarObject, CalendarDataError> =>
  Effect.try({
    try: () => new ICAL.Component(ICAL.parse(ics)),
    catch: (cause) =>
      new CalendarDataError({
        href,
        message: `${href} is not valid iCalendar data: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((vcalendar) => {
      const vevents =
        vcalendar.name === 'vcalendar'
          ? vcalendar.getAllSubcomponents('vevent')
          : [];
      const master =
        vevents.find((component) => !component.hasProperty('recurrence-id')) ??
        vevents[0];
      return master === undefined
        ? Effect.fail(
            new CalendarDataError({
              href,
              message: `${href} holds no event (VEVENT)`,
            }),
          )
        : Effect.succeed({
            vcalendar,
            master,
            overrides: vevents.filter(
              (component) =>
                component !== master && component.hasProperty('recurrence-id'),
            ),
          });
    }),
  );

const text = (component: ICAL.Component, name: string): string | undefined => {
  const value = component.getFirstPropertyValue(name);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
};

const parameter = (
  property: ICAL.Property,
  name: string,
): string | undefined => {
  const value = property.getParameter(name);
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const lowercase = (value: string | undefined): string | undefined =>
  value?.toLowerCase();

const mailtoScheme = /^mailto:/iu;

const address = (property: ICAL.Property): string =>
  String(property.getFirstValue() ?? '').replace(mailtoScheme, '');

const optional = <K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const organizerOf = (component: ICAL.Component) => {
  const property = component.getFirstProperty('organizer');
  return property === null
    ? undefined
    : {
        email: address(property),
        ...optional('name', parameter(property, 'cn')),
      };
};

const attendeesOf = (component: ICAL.Component): ReadonlyArray<Attendee> =>
  component.getAllProperties('attendee').map((property) => ({
    email: address(property),
    ...optional('name', parameter(property, 'cn')),
    ...optional('role', lowercase(parameter(property, 'role'))),
    ...optional('partstat', lowercase(parameter(property, 'partstat'))),
    ...optional(
      'rsvp',
      parameter(property, 'rsvp') === undefined
        ? undefined
        : parameter(property, 'rsvp')?.toUpperCase() === 'TRUE',
    ),
  }));

const lastDay = (start: ICAL.Time, end: ICAL.Time): ICAL.Time => {
  const day = end.clone();
  day.adjust(-1, 0, 0, 0);
  return day.compare(start) < 0 ? start : day;
};

type Span = Pick<Occurrence, 'start' | 'end' | 'startMs' | 'endMs'>;

const spanFields = (span: Span, local: DateTime.TimeZone) =>
  span.start.isDate
    ? {
        start: formatDate(span.start),
        end: formatDate(lastDay(span.start, span.end)),
        allDay: true,
      }
    : {
        start: formatInstant(span.startMs, local),
        end: formatInstant(span.endMs, local),
        allDay: false,
      };

const recurrenceText = (
  recurrenceId: NonNullable<Occurrence['recurrenceId']>,
  local: DateTime.TimeZone,
): string =>
  recurrenceId.time.isDate
    ? formatDate(recurrenceId.time)
    : formatInstant(recurrenceId.ms, local);

export const eventSummary = (
  occurrence: Occurrence,
  context: {
    readonly account: string;
    readonly calendar: string;
    readonly href: string;
  },
  local: DateTime.TimeZone,
): EventSummary => {
  const { component } = occurrence.event;
  const attendees = component.getAllProperties('attendee').length;
  return {
    ...context,
    uid: occurrence.event.uid,
    summary: text(component, 'summary') ?? '',
    ...spanFields(occurrence, local),
    ...optional('location', text(component, 'location')),
    ...optional('status', lowercase(text(component, 'status'))),
    ...optional(
      'recurrenceId',
      occurrence.recurrenceId === undefined
        ? undefined
        : recurrenceText(occurrence.recurrenceId, local),
    ),
    ...optional('organizer', organizerOf(component)?.email),
    ...optional('attendees', attendees === 0 ? undefined : attendees),
  };
};

const spanOf = (event: ICAL.Event, local: DateTime.TimeZone): Span => {
  const startTzid = tzidOf(event.component, 'dtstart');
  const { startDate: start, endDate: end } = event;
  const startMs = instantOf(start, startTzid, local);
  return {
    start,
    end,
    startMs,
    endMs: Math.max(
      startMs,
      instantOf(end, tzidOf(event.component, 'dtend') ?? startTzid, local),
    ),
  };
};

const timeText = (
  time: ICAL.Time,
  tzid: string | undefined,
  local: DateTime.TimeZone,
): string =>
  time.isDate
    ? formatDate(time)
    : formatInstant(instantOf(time, tzid, local), local);

const changeOf = (
  override: ICAL.Event,
  master: ICAL.Component,
  local: DateTime.TimeZone,
): EventChange => {
  const differs = (name: string) => {
    const value = text(override.component, name);
    return value === text(master, name) ? undefined : value;
  };
  const span = spanFields(spanOf(override, local), local);
  return {
    recurrenceId: timeText(
      override.recurrenceId,
      tzidOf(override.component, 'recurrence-id') ?? tzidOf(master, 'dtstart'),
      local,
    ),
    start: span.start,
    end: span.end,
    ...optional('summary', differs('summary')),
    ...optional('status', lowercase(differs('status'))),
    ...optional('location', differs('location')),
  };
};

const recurrenceOf = (
  master: ICAL.Component,
  overrides: ReadonlyArray<ICAL.Component>,
  local: DateTime.TimeZone,
): EventDetail['recurrence'] => {
  const rule = master.getFirstPropertyValue('rrule');
  if (!(rule instanceof ICAL.Recur)) {
    return undefined;
  }
  return {
    rule: rule.toString(),
    excluded: master.getAllProperties('exdate').flatMap((property) =>
      property
        .getValues()
        .filter((value): value is ICAL.Time => value instanceof ICAL.Time)
        .map((value) => timeText(value, parameter(property, 'tzid'), local)),
    ),
    changed: overrides.map((override) =>
      changeOf(new ICAL.Event(override), master, local),
    ),
  };
};

// Describes the event in one calendar object. A recurring event is described
// by its series, with the occurrences that differ from it.
export const eventDetail = (
  { master, overrides }: CalendarObject,
  context: {
    readonly account: string;
    readonly href: string;
    readonly etag: string | undefined;
  },
  local: DateTime.TimeZone,
): EventDetail => {
  const event = new ICAL.Event(master);
  const startTzid = tzidOf(master, 'dtstart');
  const recurrence = recurrenceOf(master, overrides, local);
  const organizer = organizerOf(master);
  return {
    account: context.account,
    href: context.href,
    ...optional('etag', context.etag),
    uid: event.uid,
    summary: text(master, 'summary') ?? '',
    ...spanFields(spanOf(event, local), local),
    ...optional(
      'timeZone',
      event.startDate.isDate
        ? undefined
        : (startTzid ??
            (event.startDate.zone?.tzid === 'UTC' ? 'UTC' : undefined)),
    ),
    ...optional('location', text(master, 'location')),
    ...optional('description', text(master, 'description')),
    ...optional('url', text(master, 'url')),
    ...optional('status', lowercase(text(master, 'status'))),
    ...optional('organizer', organizer),
    attendees: attendeesOf(master),
    ...optional('recurrence', recurrence),
  };
};
