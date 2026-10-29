import { type DateTime, type Effect, Result } from 'effect';
import type { AccountFailure } from '../../../shared/accounts/across';
import { onlyOne } from '../../../shared/dav/collections';
import type { Calendar, EventSummary } from '../schemas/calendar';
import type { TimeWindow } from './ical-time';

// An event with its start instant, which orders events across time zones.
export type DatedEvent = {
  readonly startMs: number;
  readonly event: EventSummary;
};

// Events of one account, and the events it could not read.
export type AccountEvents = {
  readonly events: ReadonlyArray<DatedEvent>;
  readonly unreadable: ReadonlyArray<AccountFailure>;
};

export type EventSearch = {
  readonly window: TimeWindow;
  // Lowercase text the event must mention.
  readonly text: string | undefined;
  readonly local: DateTime.TimeZone;
};

// CalDAV hrefs are paths, and Microsoft Graph event ids have no slash, so an
// account with both finds an event on the server its href points to.
export const isCalDavHref = (href: string): boolean => href.includes('/');

export type CalendarMatch = Result.Result<Calendar, 'ambiguous' | 'missing'>;

// The calendars of an account on one server, through CalDAV or Microsoft
// Graph.
export type CalendarSource<E> = {
  readonly calendars: ReadonlyArray<Calendar>;
  // The calendar a name or href from "pim calendar list" stands for.
  readonly find: (wanted: string) => CalendarMatch;
  // The events of one of the calendars that overlap the window.
  readonly events: (
    calendar: Calendar,
    search: EventSearch,
  ) => Effect.Effect<AccountEvents, E>;
};

export type SourcedCalendar<E> = {
  readonly source: CalendarSource<E>;
  readonly calendar: Calendar;
};

// The calendar wanted names on any of the sources. A name that matches on
// two sources is ambiguous.
export const findSourced = <E>(
  sources: ReadonlyArray<CalendarSource<E>>,
  wanted: string,
): Result.Result<SourcedCalendar<E>, 'ambiguous' | 'missing'> => {
  const matches = sources.map((source) => ({
    source,
    found: source.find(wanted),
  }));
  if (
    matches.some(
      ({ found }) => Result.isFailure(found) && found.failure === 'ambiguous',
    )
  ) {
    return Result.fail('ambiguous');
  }
  return onlyOne(
    matches.flatMap(({ source, found }) =>
      Result.isSuccess(found) ? [{ source, calendar: found.success }] : [],
    ),
  );
};

export const collectEvents = (
  account: string,
  results: ReadonlyArray<
    Result.Result<
      ReadonlyArray<DatedEvent>,
      { readonly _tag: string; readonly message: string }
    >
  >,
): AccountEvents => ({
  events: results.flatMap((result) =>
    result._tag === 'Success' ? result.success : [],
  ),
  unreadable: results.flatMap((result) =>
    result._tag === 'Failure'
      ? [
          {
            account,
            errorTag: result.failure._tag,
            message: result.failure.message,
          },
        ]
      : [],
  ),
});
