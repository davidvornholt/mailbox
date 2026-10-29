import { type DateTime, Effect } from 'effect';
import type { DavClient } from '../../../shared/dav/client';
import {
  type CalendarDataError,
  type CalendarNotFoundError,
  ReadOnlyCalendarError,
} from '../errors/errors';
import type { Calendar, EventDetail } from '../schemas/calendar';
import { fetchCalendarObject } from './caldav';
import { findCalendar, readEvent } from './calendar';
import { eventDetail, parseCalendar } from './event-fields';

export type StoredEvent = {
  readonly account: string;
  readonly href: string;
  readonly etag: string | undefined;
  readonly ics: string;
};

export const detailOf = (
  { ics, ...context }: StoredEvent,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarDataError> =>
  parseCalendar(context.href, ics).pipe(
    Effect.flatMap((object) =>
      readEvent(context.href, () => eventDetail(object, context, local)),
    ),
  );

// A status the server noted for an earlier message would read as the
// outcome of this write.
const withoutStatus = <T extends { readonly scheduleStatus?: string }>({
  scheduleStatus: _earlier,
  ...rest
}: T): Omit<T, 'scheduleStatus'> => rest;

export const withoutDelivery = (detail: EventDetail): EventDetail => ({
  ...detail,
  ...(detail.organizer === undefined
    ? {}
    : { organizer: withoutStatus(detail.organizer) }),
  attendees: detail.attendees.map(withoutStatus),
});

// The event as the server stored it. A server that changes the event as it
// stores it gives the new etag only on a read (RFC 4791, section 5.3.4).
// After a write that notified attendees, it has also noted how it delivered
// each message (RFC 6638, section 3.2.9). The write already happened, so a
// failed read falls back to the event pim wrote.
export const storedDetail = (
  client: DavClient,
  written: EventDetail,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail> =>
  fetchCalendarObject(client, written.href).pipe(
    Effect.flatMap(({ etag, ics }) =>
      detailOf(
        { account: written.account, href: written.href, etag, ics },
        local,
      ),
    ),
    Effect.orElseSucceed(() => withoutDelivery(written)),
  );

// The calendar named wanted, provided the user may write to it.
export const writableCalendar = (
  account: string,
  calendars: ReadonlyArray<Calendar>,
  wanted: string,
): Effect.Effect<Calendar, CalendarNotFoundError | ReadOnlyCalendarError> =>
  findCalendar(account, calendars, wanted).pipe(
    Effect.filterOrFail(
      (calendar) => calendar.writable !== false,
      (calendar) =>
        new ReadOnlyCalendarError({
          calendar: calendar.href,
          message: `${account} may only read the calendar "${calendar.name}"; choose one with "writable": true from "pim calendar list"`,
        }),
    ),
  );
