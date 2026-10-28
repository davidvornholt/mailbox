import { Clock, type DateTime, Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { Dav } from '../../../shared/dav/dav';
import { DavConflictError } from '../../../shared/errors/dav';
import {
  type CalendarDataError,
  type CalendarNotFoundError,
  EventChangeError,
  EventHasAttendeesError,
  ReadOnlyCalendarError,
} from '../errors/errors';
import type { EventDetail } from '../schemas/calendar';
import {
  type CalendarResource,
  createCalendarObject,
  deleteCalendarObject,
  fetchCalendarObject,
  listCalendars,
  replaceCalendarObject,
} from './caldav';
import { type CalendarError, findCalendar, readEvent } from './calendar';
import {
  type CalendarObject,
  eventDetail,
  parseCalendar,
} from './event-fields';
import type { EventSpan } from './event-times';
import {
  applyChanges,
  type EventChanges,
  type EventText,
  isRecurring,
  newEventIcs,
  otherAttendees,
} from './event-write';

export type CalendarWriteError =
  | CalendarError
  | CalendarDataError
  | CalendarNotFoundError
  | ReadOnlyCalendarError
  | EventHasAttendeesError
  | EventChangeError;

type StoredEvent = {
  readonly account: string;
  readonly href: string;
  readonly etag: string | undefined;
  readonly ics: string;
};

const detailOf = (
  { ics, ...context }: StoredEvent,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarDataError> =>
  parseCalendar(context.href, ics).pipe(
    Effect.flatMap((object) =>
      readEvent(context.href, () => eventDetail(object, context, local)),
    ),
  );

export type NewEventRequest = EventText & {
  // A calendar name or href from "pim calendar list".
  readonly calendar: string;
  readonly title: string;
  readonly span: EventSpan;
};

export const createEvent = (
  account: Account,
  request: NewEventRequest,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const calendars = yield* listCalendars(client);
    const { calendar: wanted, ...event } = request;
    const calendar = yield* findCalendar(account.email, calendars, wanted);
    if (calendar.writable === false) {
      return yield* new ReadOnlyCalendarError({
        calendar: calendar.href,
        message: `${account.email} may only read the calendar "${calendar.name}"; choose one with "writable": true from "pim calendar list"`,
      });
    }
    const uid = crypto.randomUUID();
    const folder = calendar.href.endsWith('/')
      ? calendar.href
      : `${calendar.href}/`;
    const href = `${folder}${uid}.ics`;
    const ics = newEventIcs({ ...event, uid }, yield* Clock.currentTimeMillis);
    const etag = yield* createCalendarObject(client, href, ics);
    return yield* detailOf({ account: account.email, href, etag, ics }, local);
  });

export type EventTarget = {
  readonly href: string;
  // The etag from "pim calendar get"; pim changes only that version.
  readonly etag: string;
  // Allows a change to every occurrence of a recurring event.
  readonly series: boolean;
};

// The event at the target's href, provided it is still the version the
// caller read and changing it emails no one.
const changeableEvent = (
  client: DavClient,
  target: EventTarget,
): Effect.Effect<
  { readonly resource: CalendarResource; readonly object: CalendarObject },
  CalendarWriteError
> =>
  Effect.gen(function* () {
    const { href } = target;
    const resource = yield* fetchCalendarObject(client, href);
    if (resource.etag === undefined) {
      return yield* new EventChangeError({
        href,
        message: `The server gave no etag for ${href}, so pim cannot make sure it changes the version you read`,
      });
    }
    if (resource.etag !== target.etag) {
      return yield* new DavConflictError({
        href,
        message: `${href} changed since you read it: its etag is now ${resource.etag}. Run "pim calendar get" again and check that the change still applies`,
      });
    }
    const object = yield* parseCalendar(href, resource.ics);
    const attendees = otherAttendees(object.vcalendar);
    if (attendees.length > 0) {
      return yield* new EventHasAttendeesError({
        href,
        message: `${href} is a meeting with ${attendees.join(', ')}. Changing or deleting it could email them, so pim leaves it alone; the user can change it in a calendar app`,
      });
    }
    if (isRecurring(object) && !target.series) {
      return yield* new EventChangeError({
        href,
        message: `${href} is a recurring event, so this would affect every occurrence. Pass --series if that is intended`,
      });
    }
    return { resource, object };
  });

export const updateEvent = (
  account: Account,
  target: EventTarget,
  changes: EventChanges,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav> =>
  Effect.gen(function* () {
    const { href, etag } = target;
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const { object } = yield* changeableEvent(client, target);
    const now = yield* Clock.currentTimeMillis;
    const applied = yield* readEvent(href, () =>
      applyChanges(object, changes, local, now),
    );
    if (Result.isFailure(applied)) {
      return yield* new EventChangeError({ href, message: applied.failure });
    }
    const ics = object.vcalendar.toString();
    const newEtag = yield* replaceCalendarObject(client, href, ics, etag);
    return yield* detailOf(
      { account: account.email, href, etag: newEtag, ics },
      local,
    );
  });

export const deleteEvent = (
  account: Account,
  target: EventTarget,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const { resource } = yield* changeableEvent(client, target);
    const detail = yield* detailOf(
      {
        account: account.email,
        href: target.href,
        etag: undefined,
        ics: resource.ics,
      },
      local,
    );
    yield* deleteCalendarObject(client, target.href, target.etag);
    return detail;
  });
