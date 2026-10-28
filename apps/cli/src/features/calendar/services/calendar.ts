import { type DateTime, Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { AccountFailure } from '../../../shared/dav/accounts';
import {
  describeCollections,
  findCollection,
} from '../../../shared/dav/collections';
import { Dav, type DavSessionError } from '../../../shared/dav/dav';
import type { DavRequestError } from '../../../shared/errors/dav';
import { CalendarDataError, CalendarNotFoundError } from '../errors/errors';
import type { Calendar, EventDetail, EventSummary } from '../schemas/calendar';
import {
  type CalendarResource,
  fetchCalendarObject,
  listCalendars,
  queryEvents,
} from './caldav';
import { eventDetail, eventSummary, parseCalendar } from './event-fields';
import type { TimeWindow } from './ical-time';
import { type Occurrence, occurrencesIn } from './occurrences';

const calendarConcurrency = 4;

export type CalendarError = DavSessionError | DavRequestError;

export const accountCalendars = (
  account: Account,
): Effect.Effect<ReadonlyArray<Calendar>, CalendarError, Dav> =>
  Dav.pipe(
    Effect.flatMap((dav) => dav.client(account)),
    Effect.flatMap(listCalendars),
  );

export const findCalendar = (
  account: string,
  calendars: ReadonlyArray<Calendar>,
  wanted: string,
): Effect.Effect<Calendar, CalendarNotFoundError> =>
  Result.match(findCollection(calendars, wanted), {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(
        new CalendarNotFoundError({
          calendar: wanted,
          message:
            reason === 'ambiguous'
              ? `${account} has several calendars that match "${wanted}"; pass an exact href from "pim calendar list" instead`
              : `${account} has no calendar "${wanted}". Its calendars: ${describeCollections(calendars)}`,
        }),
      ),
  });

export type EventQuery = {
  readonly window: TimeWindow;
  readonly calendar?: string;
  readonly text?: string;
};

// An event with its start instant, which orders events across time zones.
export type DatedEvent = {
  readonly startMs: number;
  readonly event: EventSummary;
};

// Events of one account, and the calendar objects it could not read.
export type AccountEvents = {
  readonly events: ReadonlyArray<DatedEvent>;
  readonly unreadable: ReadonlyArray<AccountFailure>;
};

const searchedProperties = ['summary', 'location', 'description'];

const mentions = (occurrence: Occurrence, text: string): boolean =>
  searchedProperties.some((name) =>
    String(occurrence.event.component.getFirstPropertyValue(name) ?? '')
      .toLowerCase()
      .includes(text),
  );

type EventSearch = {
  readonly account: string;
  readonly calendar: string;
  readonly window: TimeWindow;
  readonly text: string | undefined;
};

// ical.js decodes a value only when it is read, so a malformed field, such as
// an invalid DURATION, throws here rather than in parseCalendar. So does an
// event pim can't expand completely.
export const readEvent = <A>(
  href: string,
  read: () => A,
): Effect.Effect<A, CalendarDataError> =>
  Effect.try({
    try: read,
    catch: (cause) =>
      new CalendarDataError({
        href,
        message: `Could not read ${href}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

// The events of one calendar object that overlap the window and mention the
// searched text.
const datedEvents = (
  resource: CalendarResource,
  search: EventSearch,
  local: DateTime.TimeZone,
): Effect.Effect<ReadonlyArray<DatedEvent>, CalendarDataError> =>
  parseCalendar(resource.href, resource.ics).pipe(
    Effect.flatMap(({ vcalendar }) =>
      readEvent(resource.href, () =>
        occurrencesIn(vcalendar, search.window, local)
          .filter(
            (occurrence) =>
              search.text === undefined || mentions(occurrence, search.text),
          )
          .map((occurrence) => ({
            startMs: occurrence.startMs,
            event: eventSummary(
              occurrence,
              {
                account: search.account,
                calendar: search.calendar,
                href: resource.href,
              },
              local,
            ),
          })),
      ),
    ),
  );

export const accountEvents = (
  account: Account,
  query: EventQuery,
  local: DateTime.TimeZone,
): Effect.Effect<AccountEvents, CalendarError | CalendarNotFoundError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const calendars = yield* listCalendars(client);
    const selected =
      query.calendar === undefined
        ? calendars
        : [yield* findCalendar(account.email, calendars, query.calendar)];
    const text = query.text?.trim().toLowerCase();
    const perCalendar = yield* Effect.forEach(
      selected,
      (calendar) =>
        queryEvents(client, calendar.href, query.window).pipe(
          Effect.flatMap((resources) =>
            Effect.forEach(resources, (resource) =>
              Effect.fromResult(resource).pipe(
                Effect.flatMap((found) =>
                  datedEvents(
                    found,
                    {
                      account: account.email,
                      calendar: calendar.name,
                      window: query.window,
                      text,
                    },
                    local,
                  ),
                ),
                Effect.result,
              ),
            ),
          ),
        ),
      { concurrency: calendarConcurrency },
    );
    const results = perCalendar.flat();
    return {
      events: results.flatMap((result) =>
        result._tag === 'Success' ? result.success : [],
      ),
      unreadable: results.flatMap((result) =>
        result._tag === 'Failure'
          ? [
              {
                account: account.email,
                errorTag: result.failure._tag,
                message: result.failure.message,
              },
            ]
          : [],
      ),
    };
  });

export const byStart = (left: DatedEvent, right: DatedEvent): number =>
  left.startMs - right.startMs ||
  left.event.summary.localeCompare(right.event.summary);

export const accountEvent = (
  account: Account,
  href: string,
  local: DateTime.TimeZone,
): Effect.Effect<
  EventDetail & { readonly ics: string },
  CalendarError | CalendarDataError,
  Dav
> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const resource = yield* fetchCalendarObject(client, href);
    const object = yield* parseCalendar(href, resource.ics);
    const detail = yield* readEvent(href, () =>
      eventDetail(
        object,
        { account: account.email, href, etag: resource.etag },
        local,
      ),
    );
    return { ...detail, ics: resource.ics };
  });
