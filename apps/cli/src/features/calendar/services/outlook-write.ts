import { type DateTime, Effect, Result, Schema } from 'effect';
import {
  GraphConflictError,
  type GraphRequestError,
} from '../../../shared/errors/graph';
import type { GraphClient } from '../../../shared/graph/client';
import {
  type CalendarDataError,
  EventChangeError,
  EventHasAttendeesError,
  ReadOnlyCalendarError,
} from '../errors/errors';
import type { EventDetail } from '../schemas/calendar';
import { newAttendees } from './event-attendees';
import { changedSpan, type EventSpan } from './event-times';
import type { EventChanges, EventText } from './event-write';
import {
  eventPath,
  eventPreferences,
  graphDetailOf,
  readGraphEvent,
} from './graph-calendar';
import { GraphCalendar, GraphEvent, graphSpan, nonEmpty } from './graph-events';
import {
  allowsTeams,
  changedAttendees,
  eventSpanOf,
  graphText,
  graphTimes,
  notifiedAttendees,
  requiredAttendee,
  teamsMeeting,
} from './outlook-event';

export type OutlookWriteError =
  | GraphRequestError
  | CalendarDataError
  | ReadOnlyCalendarError
  | EventHasAttendeesError
  | EventChangeError;

// How pim writes an Outlook event's times, and whether it adds a Teams
// meeting.
export type OutlookOptions = {
  // The zone Outlook keeps and shows the event's times in.
  readonly zone: DateTime.TimeZone;
  readonly teams: boolean;
};

export type OutlookEventRequest = EventText &
  OutlookOptions & {
    readonly title: string;
    readonly span: EventSpan;
    readonly attendees: ReadonlyArray<string>;
    readonly notifyAttendees: boolean;
  };

const nameOf = (calendar: GraphCalendar): string =>
  nonEmpty(calendar.name) ?? calendar.id;

const noTeams = (account: string, calendar: GraphCalendar) =>
  new EventChangeError({
    href: calendar.id,
    message: `The Outlook calendar "${nameOf(calendar)}" of ${account} allows no Teams meetings. Only calendars of Microsoft 365 work or school accounts do`,
  });

// The event as Microsoft Graph stored it. The write already happened, so a
// failed read falls back to Microsoft Graph's answer to the write.
const storedDetail = (
  client: GraphClient,
  written: GraphEvent,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, GraphRequestError | CalendarDataError> =>
  readGraphEvent(client, written.id).pipe(
    Effect.orElseSucceed(() => written),
    Effect.flatMap((event) => graphDetailOf(client, event, local)),
  );

// Microsoft Graph emails each attendee of a new event an invitation.
const invitees = (
  client: GraphClient,
  calendar: GraphCalendar,
  { attendees, notifyAttendees }: OutlookEventRequest,
): Effect.Effect<ReadonlyArray<string>, OutlookWriteError> => {
  if (attendees.length === 0) {
    return Effect.succeed([]);
  }
  if (!notifyAttendees) {
    return Effect.fail(
      new EventHasAttendeesError({
        href: calendar.id,
        message: `Creating an event with attendees makes Microsoft email each of them an invitation. Pass --notify-attendees only if the user asked to invite ${attendees.join(', ')}`,
      }),
    );
  }
  return Result.match(
    newAttendees(attendees, new Set([client.account.toLowerCase()])),
    {
      onSuccess: Effect.succeed,
      onFailure: (reason) =>
        Effect.fail(
          new EventChangeError({ href: calendar.id, message: reason }),
        ),
    },
  );
};

export const createOutlookEvent = (
  client: GraphClient,
  calendar: GraphCalendar,
  request: OutlookEventRequest,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, OutlookWriteError> =>
  Effect.gen(function* () {
    if (calendar.canEdit === false) {
      return yield* new ReadOnlyCalendarError({
        calendar: calendar.id,
        message: `${client.account} may only read the calendar "${nameOf(calendar)}"; choose one with "writable": true from "pim calendar list"`,
      });
    }
    if (request.teams && !allowsTeams(calendar)) {
      return yield* noTeams(client.account, calendar);
    }
    const invited = yield* invitees(client, calendar, request);
    const written = yield* client.send(
      {
        method: 'POST',
        path: `/me/calendars/${encodeURIComponent(calendar.id)}/events`,
        body: {
          ...graphText(request),
          ...graphTimes(request.span, request.zone),
          ...(invited.length === 0
            ? {}
            : { attendees: invited.map(requiredAttendee) }),
          ...(request.teams ? teamsMeeting : {}),
        },
      },
      GraphEvent,
      { prefer: eventPreferences },
    );
    return yield* storedDetail(client, written, local);
  });

export type OutlookTarget = {
  readonly href: string;
  readonly etag: string;
  readonly series: boolean;
  readonly notifyAttendees: boolean;
};

// The event at the target's href, provided it is still the version the
// caller read, the write may change every occurrence it touches, and the
// user organizes it.
const currentEvent = (
  client: GraphClient,
  target: OutlookTarget,
): Effect.Effect<GraphEvent, OutlookWriteError> =>
  Effect.gen(function* () {
    const { href } = target;
    const event = yield* readGraphEvent(client, href);
    const etag = nonEmpty(event['@odata.etag']);
    if (etag === undefined) {
      return yield* new EventChangeError({
        href,
        message: `Microsoft Graph gave no etag for ${href}, so pim cannot make sure it changes the version you read`,
      });
    }
    if (etag !== target.etag) {
      return yield* new GraphConflictError({
        href,
        message: `${href} changed since you read it: its etag is now ${etag}. Run "pim calendar get" again and check that the change still applies`,
      });
    }
    if (event.type === 'seriesMaster' && !target.series) {
      return yield* new EventChangeError({
        href,
        message: `${href} is a recurring event, so this would affect every occurrence. Pass --series if that is intended`,
      });
    }
    return event;
  });

const organizerOf = (event: GraphEvent): string =>
  nonEmpty(event.organizer?.emailAddress?.address) ?? 'someone else';

const othersMeeting = (event: GraphEvent, doing: string, hint: string) =>
  new EventHasAttendeesError({
    href: event.id,
    message: `${event.id} is a meeting ${organizerOf(event)} organizes, so pim does not ${doing} it. ${hint}`,
  });

const unasked = (
  event: GraphEvent,
  emails: ReadonlyArray<string>,
  sends: string,
) =>
  new EventHasAttendeesError({
    href: event.id,
    message: `This makes Microsoft email ${emails.join(', ')} ${sends}. Pass --notify-attendees only if the user asked to tell them`,
  });

export type OutlookChanges = EventChanges & OutlookOptions;

const changedTimes = (
  event: GraphEvent,
  changes: OutlookChanges,
  local: DateTime.TimeZone,
) =>
  Effect.gen(function* () {
    if (changes.start === undefined && changes.end === undefined) {
      return {};
    }
    if (event.type === 'seriesMaster') {
      return yield* new EventChangeError({
        href: event.id,
        message:
          'pim does not move recurring events; move one occurrence by its href from "pim calendar events", or change the times of the series in Outlook',
      });
    }
    const current = eventSpanOf(yield* graphSpan(event, local));
    const span =
      current === undefined
        ? Result.fail(`pim cannot read the times of ${event.id}`)
        : changedSpan(current, changes.start, changes.end);
    if (Result.isFailure(span)) {
      return yield* new EventChangeError({
        href: event.id,
        message: span.failure,
      });
    }
    return graphTimes(span.success, changes.zone);
  });

const changedGuests = (event: GraphEvent, changes: OutlookChanges) => {
  const add = changes.addAttendees ?? [];
  const remove = changes.removeAttendees ?? [];
  if (add.length + remove.length === 0) {
    return Effect.succeed({ body: {}, added: [] });
  }
  return Result.match(changedAttendees(event, add, remove), {
    onSuccess: ({ attendees, added }) =>
      Effect.succeed({ body: { attendees }, added }),
    onFailure: (reason) =>
      Effect.fail(new EventChangeError({ href: event.id, message: reason })),
  });
};

// Whether the calendar holding the event allows Teams meetings. Microsoft
// Graph may name another calendar of the account here, so the error names
// the event.
const eventAllowsTeams = (client: GraphClient, event: GraphEvent) =>
  client
    .get(
      `${eventPath(event.id)}/calendar?$select=id,allowedOnlineMeetingProviders`,
      GraphCalendar,
    )
    .pipe(
      Effect.flatMap((calendar) =>
        allowsTeams(calendar)
          ? Effect.void
          : Effect.fail(
              new EventChangeError({
                href: event.id,
                message: `The Outlook calendar of ${event.id} allows no Teams meetings. Only calendars of Microsoft 365 work or school accounts do`,
              }),
            ),
      ),
    );

export const updateOutlookEvent = (
  client: GraphClient,
  target: OutlookTarget,
  changes: OutlookChanges,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, OutlookWriteError> =>
  Effect.gen(function* () {
    const event = yield* currentEvent(client, target);
    if (event.isOrganizer === false) {
      return yield* othersMeeting(
        event,
        'change',
        `Answer it with "pim calendar respond --account ${client.account} --href ${event.id} --partstat <accepted|tentative|declined>"`,
      );
    }
    const guests = yield* changedGuests(event, changes);
    const notified = [
      ...new Set([...notifiedAttendees(event), ...guests.added]),
    ];
    if (notified.length > 0 && !target.notifyAttendees) {
      return yield* unasked(event, notified, 'an update');
    }
    const addsTeams = changes.teams && event.isOnlineMeeting !== true;
    if (addsTeams) {
      yield* eventAllowsTeams(client, event);
    }
    const body = {
      ...graphText(changes),
      ...(yield* changedTimes(event, changes, local)),
      ...guests.body,
      ...(addsTeams ? teamsMeeting : {}),
    };
    if (Object.keys(body).length === 0) {
      return yield* graphDetailOf(client, event, local);
    }
    const written = yield* client.send(
      {
        method: 'PATCH',
        path: eventPath(event.id),
        body,
        ifMatch: target.etag,
      },
      GraphEvent,
      { prefer: eventPreferences },
    );
    return yield* storedDetail(client, written, local);
  });

// Microsoft Graph ignores If-Match on a DELETE, so pim compares the etag
// just before. Deleting a meeting the user organizes emails the attendees a
// cancellation. Microsoft Graph does not say what deleting the user's copy
// of someone else's meeting sends, so pim leaves that to a silent decline.
export const deleteOutlookEvent = (
  client: GraphClient,
  target: OutlookTarget,
  local: DateTime.TimeZone,
): Effect.Effect<EventDetail, OutlookWriteError> =>
  Effect.gen(function* () {
    const event = yield* currentEvent(client, target);
    if (event.isOrganizer === false) {
      return yield* othersMeeting(
        event,
        'delete',
        `Remove it without telling anyone with "pim calendar respond --account ${client.account} --href ${event.id} --partstat declined", leaving out --notify-organizer`,
      );
    }
    const notified = notifiedAttendees(event);
    if (notified.length > 0 && !target.notifyAttendees) {
      return yield* unasked(event, notified, 'a cancellation');
    }
    const detail = yield* graphDetailOf(client, event, local);
    yield* client.send(
      { method: 'DELETE', path: eventPath(event.id) },
      Schema.Unknown,
    );
    return detail;
  });
