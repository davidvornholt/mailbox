import { DateTime, Result } from 'effect';
import {
  addDays,
  formatCalendarDate,
  parseCalendarDate,
} from './calendar-dates';
import { newAttendees } from './event-attendees';
import type { EventSpan } from './event-times';
import type { EventText } from './event-write';
import type {
  GraphAttendee,
  GraphCalendar,
  GraphEvent,
  GraphSpan,
} from './graph-events';
import { nonEmpty } from './graph-events';
import { formatInstant } from './ical-time';

// The provider of Teams meetings. Outlook.com calendars allow none: they
// list only "unknown", and Microsoft Graph ignores a request for one there.
export const teamsProvider = 'teamsForBusiness';

const wallClockLength = 'YYYY-MM-DDTHH:mm:ss'.length;

// Microsoft Graph keeps an event's times as wall-clock times in the zone
// Outlook shows it in. An all-day event lasts from midnight of its first day
// to midnight after its last.
export const graphTimes = (span: EventSpan, zone: DateTime.TimeZone) => {
  const timeZone = DateTime.zoneToString(zone);
  if (span._tag === 'Days') {
    return {
      isAllDay: true,
      start: {
        dateTime: `${formatCalendarDate(span.first)}T00:00:00`,
        timeZone,
      },
      end: {
        dateTime: `${formatCalendarDate(addDays(span.last, 1))}T00:00:00`,
        timeZone,
      },
    };
  }
  const wallClock = (ms: number) =>
    formatInstant(ms, zone).slice(0, wallClockLength);
  return {
    isAllDay: false,
    start: { dateTime: wallClock(span.startMs), timeZone },
    end: { dateTime: wallClock(span.endMs), timeZone },
  };
};

// The span of an Outlook event as pim changes it.
export const eventSpanOf = (span: GraphSpan): EventSpan | undefined => {
  if (!span.allDay) {
    return { _tag: 'Times', startMs: span.startMs, endMs: span.endMs };
  }
  const first = parseCalendarDate(span.start);
  const last = parseCalendarDate(span.end);
  return first === undefined || last === undefined
    ? undefined
    : { _tag: 'Days', first, last };
};

// An empty location or description removes it.
export const graphText = (text: EventText) => ({
  ...(text.title === undefined ? {} : { subject: text.title }),
  ...(text.location === undefined
    ? {}
    : { location: { displayName: text.location } }),
  ...(text.description === undefined
    ? {}
    : { body: { contentType: 'text', content: text.description } }),
});

export const teamsMeeting = {
  isOnlineMeeting: true,
  onlineMeetingProvider: teamsProvider,
} as const;

export const allowsTeams = (calendar: GraphCalendar): boolean =>
  (calendar.allowedOnlineMeetingProviders ?? []).includes(teamsProvider);

type AttendeeWrite = {
  readonly emailAddress: { readonly address: string; readonly name?: string };
  readonly type: string;
};

export const requiredAttendee = (address: string): AttendeeWrite => ({
  emailAddress: { address },
  type: 'required',
});

const keyOf = (email: string): string => email.trim().toLowerCase();

const organizerKey = (event: Pick<GraphEvent, 'organizer'>): string =>
  keyOf(event.organizer?.emailAddress?.address ?? '');

// The attendees of the event other than its organizer, whom Microsoft Graph
// lists with the response "organizer".
const guests = (
  event: Pick<GraphEvent, 'attendees' | 'organizer'>,
): ReadonlyArray<GraphAttendee & { readonly address: string }> => {
  const organizer = organizerKey(event);
  return (event.attendees ?? []).flatMap((attendee) => {
    const address = nonEmpty(attendee.emailAddress?.address);
    return address === undefined ||
      keyOf(address) === organizer ||
      attendee.status?.response === 'organizer'
      ? []
      : [{ ...attendee, address }];
  });
};

// Whom Microsoft Graph emails when the organizer changes or deletes the
// event.
export const notifiedAttendees = (
  event: Pick<GraphEvent, 'attendees' | 'organizer'>,
): ReadonlyArray<string> => guests(event).map(({ address }) => address);

// The attendees after the change. Microsoft Graph replaces the whole list,
// and keeps the answers of the attendees that stay on it.
export const changedAttendees = (
  event: Pick<GraphEvent, 'attendees' | 'organizer'>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): Result.Result<
  {
    readonly attendees: ReadonlyArray<AttendeeWrite>;
    readonly added: ReadonlyArray<string>;
  },
  string
> => {
  const present = guests(event);
  const added = newAttendees(
    add,
    new Set([
      organizerKey(event),
      ...present.map(({ address }) => keyOf(address)),
    ]),
  );
  if (Result.isFailure(added)) {
    return Result.fail(added.failure);
  }
  const removed = new Set(remove.map(keyOf));
  const missing = remove.find(
    (email) => !present.some(({ address }) => keyOf(address) === keyOf(email)),
  );
  if (missing !== undefined) {
    return Result.fail(`${missing.trim()} is not an attendee`);
  }
  const kept = present.flatMap((attendee): ReadonlyArray<AttendeeWrite> => {
    if (removed.has(keyOf(attendee.address))) {
      return [];
    }
    const name = nonEmpty(attendee.emailAddress?.name);
    return [
      {
        emailAddress: {
          address: attendee.address,
          ...(name === undefined ? {} : { name }),
        },
        type: nonEmpty(attendee.type) ?? 'required',
      },
    ];
  });
  return Result.succeed({
    attendees: [...kept, ...added.success.map(requiredAttendee)],
    added: added.success,
  });
};
