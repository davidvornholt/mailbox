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
  type SchedulingUnsupportedError,
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
import { newAttendees, type Organizer, setOrganizer } from './event-attendees';
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
  type Invitation,
  isRecurring,
  newEventIcs,
} from './event-write';
import { meetingOrganizer, writeOrganizer } from './scheduling';

export type CalendarWriteError =
  | CalendarError
  | CalendarDataError
  | CalendarNotFoundError
  | ReadOnlyCalendarError
  | EventHasAttendeesError
  | EventChangeError
  | SchedulingUnsupportedError;

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

// A status the server noted for an earlier message would read as the
// outcome of this write.
const withoutDelivery = (detail: EventDetail): EventDetail => ({
  ...detail,
  attendees: detail.attendees.map(
    ({ scheduleStatus: _earlier, ...attendee }) => attendee,
  ),
});

// The event as the server stored it after a write that notified attendees.
// The server notes how it delivered each message (RFC 6638, section 3.2.9)
// and, as it changed the data, may give the new etag only on a read. The
// write already happened, so a failed read falls back to the event pim
// wrote.
const storedDetail = (
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

export type NewEventRequest = EventText & {
  // A calendar name or href from "pim calendar list".
  readonly calendar: string;
  readonly title: string;
  readonly span: EventSpan;
  // Addresses to invite. The server emails each of them an invitation, so
  // pim invites them only with notifyAttendees.
  readonly attendees: ReadonlyArray<string>;
  readonly notifyAttendees: boolean;
};

// The invitation of a new event in the calendar at href, or none when the
// event has no attendees.
const invitationOf = (
  client: DavClient,
  account: Account,
  href: string,
  { attendees, notifyAttendees }: NewEventRequest,
): Effect.Effect<Invitation | undefined, CalendarWriteError> =>
  Effect.gen(function* () {
    if (attendees.length === 0) {
      return;
    }
    if (!notifyAttendees) {
      return yield* new EventHasAttendeesError({
        href,
        message: `Creating an event with attendees makes the server email each of them an invitation. Pass --notify-attendees only if the user asked to invite ${attendees.join(', ')}`,
      });
    }
    const { organizer, addresses } = yield* meetingOrganizer(
      client,
      account,
      href,
    );
    const invited = newAttendees(attendees, new Set(addresses));
    if (Result.isFailure(invited)) {
      return yield* new EventChangeError({ href, message: invited.failure });
    }
    return { organizer, attendees: invited.success };
  });

export const createEvent = (
  account: Account,
  request: NewEventRequest,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const calendars = yield* listCalendars(client);
    const {
      calendar: wanted,
      attendees: _attendees,
      notifyAttendees: _notifyAttendees,
      ...event
    } = request;
    const calendar = yield* findCalendar(account.email, calendars, wanted);
    if (calendar.writable === false) {
      return yield* new ReadOnlyCalendarError({
        calendar: calendar.href,
        message: `${account.email} may only read the calendar "${calendar.name}"; choose one with "writable": true from "pim calendar list"`,
      });
    }
    const invitation = yield* invitationOf(
      client,
      account,
      calendar.href,
      request,
    );
    const uid = crypto.randomUUID();
    const folder = calendar.href.endsWith('/')
      ? calendar.href
      : `${calendar.href}/`;
    const href = `${folder}${uid}.ics`;
    const ics = newEventIcs(
      { ...event, uid, ...(invitation === undefined ? {} : { invitation }) },
      yield* Clock.currentTimeMillis,
    );
    const detail = (etag: string | undefined) =>
      detailOf({ account: account.email, href, etag, ics }, local);
    yield* detail(undefined);
    const written = yield* detail(
      yield* createCalendarObject(client, href, ics),
    );
    return invitation === undefined
      ? written
      : yield* storedDetail(client, written, local);
  });

export type EventTarget = {
  readonly href: string;
  // The etag from "pim calendar get"; pim changes only that version.
  readonly etag: string;
  // Allows a change to every occurrence of a recurring event.
  readonly series: boolean;
  // Allows a change that makes the server email the attendees.
  readonly notifyAttendees: boolean;
};

// The event at the target's href, provided it is still the version the
// caller read and pim may make the write, with the organizer the server
// emails the attendees as when the write makes it email them.
const changeableEvent = (
  client: DavClient,
  account: Account,
  target: EventTarget,
  invites: boolean,
): Effect.Effect<
  {
    readonly resource: CalendarResource;
    readonly object: CalendarObject;
    readonly organizer: Organizer | undefined;
  },
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
    if (isRecurring(object) && !target.series) {
      return yield* new EventChangeError({
        href,
        message: `${href} is a recurring event, so this would affect every occurrence. Pass --series if that is intended`,
      });
    }
    const organizer = yield* writeOrganizer(client, account, {
      href,
      object,
      invites,
      notifyAttendees: target.notifyAttendees,
    });
    return { resource, object, organizer };
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
    const invites = (changes.addAttendees ?? []).length > 0;
    const { object, organizer } = yield* changeableEvent(
      client,
      account,
      target,
      invites,
    );
    for (const event of [object.master, ...object.overrides]) {
      if (organizer !== undefined && !event.hasProperty('organizer')) {
        setOrganizer(event, organizer);
      }
    }
    const now = yield* Clock.currentTimeMillis;
    const applied = yield* readEvent(href, () =>
      applyChanges(object, changes, local, now),
    );
    if (Result.isFailure(applied)) {
      return yield* new EventChangeError({ href, message: applied.failure });
    }
    const ics = object.vcalendar.toString();
    const detail = (newEtag: string | undefined) =>
      detailOf({ account: account.email, href, etag: newEtag, ics }, local);
    yield* detail(undefined);
    const written = yield* detail(
      yield* replaceCalendarObject(client, href, ics, etag),
    );
    return organizer === undefined
      ? written
      : yield* storedDetail(client, written, local);
  });

// Deleting a meeting the user organizes makes the server email the
// attendees a cancellation.
export const deleteEvent = (
  account: Account,
  target: EventTarget,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, CalendarWriteError, Dav> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const { resource, organizer } = yield* changeableEvent(
      client,
      account,
      target,
      false,
    );
    const detail = yield* detailOf(
      {
        account: account.email,
        href: target.href,
        etag: undefined,
        ics: resource.ics,
      },
      local,
    );
    yield* deleteCalendarObject(
      client,
      target.href,
      target.etag,
      organizer !== undefined,
    );
    return withoutDelivery(detail);
  });
