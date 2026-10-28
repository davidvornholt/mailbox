import { Duration, Effect, Result } from 'effect';
import { type DavClient, xmlBody } from '../../../shared/dav/client';
import { lastSegment } from '../../../shared/dav/collections';
import {
  discoverPrincipal,
  listCollections,
} from '../../../shared/dav/discovery';
import {
  createResource,
  deleteResource,
  replaceResource,
} from '../../../shared/dav/resources';
import {
  childElements,
  type DavResource,
  findProp,
  hasResourceType,
  isWritable,
  ns,
  propFailure,
  propText,
} from '../../../shared/dav/xml';
import { DavError, type DavRequestError } from '../../../shared/errors/dav';
import { CalendarDataError } from '../errors/errors';
import type { Calendar } from '../schemas/calendar';
import { formatUtcStamp, type TimeWindow } from './ical-time';

// The iCalendar text of one calendar object, with the ETag a later change
// must match.
export type CalendarResource = {
  readonly href: string;
  readonly etag: string | undefined;
  readonly ics: string;
};

const calendarProps =
  '<d:resourcetype/><d:displayname/><c:calendar-description/><ical:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/>';

// Calendars that declare no components accept all of them.
const holdsEvents = (resource: DavResource): boolean => {
  const components = findProp(
    resource,
    ns.caldav,
    'supported-calendar-component-set',
  );
  return (
    components === undefined ||
    childElements(components, ns.caldav, 'comp').some(
      (component) => component.getAttribute('name')?.toUpperCase() === 'VEVENT',
    )
  );
};

const toCalendar = (account: string, resource: DavResource): Calendar => {
  const description = propText(resource, ns.caldav, 'calendar-description');
  const color = propText(resource, ns.apple, 'calendar-color');
  const writable = isWritable(resource);
  return {
    account,
    href: resource.href,
    name:
      propText(resource, ns.dav, 'displayname') ?? lastSegment(resource.href),
    ...(description === undefined ? {} : { description }),
    ...(color === undefined ? {} : { color }),
    ...(writable === undefined ? {} : { writable }),
  };
};

export const listCalendars = (
  client: DavClient,
): Effect.Effect<ReadonlyArray<Calendar>, DavRequestError> =>
  Effect.gen(function* () {
    const principal = yield* discoverPrincipal(client);
    if (principal.calendarHomes.length === 0) {
      return yield* new DavError({
        message: `The DAV server of ${client.login.account} offers no calendars (it names no calendar-home-set)`,
      });
    }
    const collections = yield* listCollections(
      client,
      principal.calendarHomes,
      calendarProps,
    );
    return collections
      .filter(
        (resource) =>
          hasResourceType(resource, ns.caldav, 'calendar') &&
          holdsEvents(resource),
      )
      .map((resource) => toCalendar(client.login.account, resource));
  });

const toCalendarResource = (
  resource: DavResource,
): Result.Result<CalendarResource, CalendarDataError> => {
  const ics = propText(resource, ns.caldav, 'calendar-data');
  if (ics !== undefined) {
    return Result.succeed({
      href: resource.href,
      etag: propText(resource, ns.dav, 'getetag'),
      ics,
    });
  }
  const status = propFailure(resource, ns.caldav, 'calendar-data');
  return Result.fail(
    new CalendarDataError({
      href: resource.href,
      message: `The server did not return the event data of ${resource.href}${status === undefined ? '' : ` (HTTP ${status})`}`,
    }),
  );
};

// pim reads a floating time, such as an all-day date, in the local zone, but
// the server may read it in UTC or another zone (RFC 4791, section 7.3). UTC
// offsets lie between -12:00 and +14:00, so two readings differ by at most 26
// hours; the server range is that much wider, and occurrencesIn keeps the
// exact window.
const floatingHours = 26;
const floatingMs = Duration.toMillis(Duration.hours(floatingHours));

// The calendar objects with an event in the window; the server expands
// recurring events to decide. Objects the server could not return fail.
export const queryEvents = (
  client: DavClient,
  calendarHref: string,
  window: TimeWindow,
): Effect.Effect<
  ReadonlyArray<Result.Result<CalendarResource, CalendarDataError>>,
  DavRequestError
> =>
  client
    .report(
      calendarHref,
      '1',
      xmlBody(
        'c:calendar-query',
        `<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${formatUtcStamp(window.startMs - floatingMs)}" end="${formatUtcStamp(window.endMs + floatingMs)}"/></c:comp-filter></c:comp-filter></c:filter>`,
      ),
    )
    .pipe(Effect.map((resources) => resources.map(toCalendarResource)));

export const fetchCalendarObject = (
  client: DavClient,
  href: string,
): Effect.Effect<CalendarResource, DavRequestError> =>
  client.send({ method: 'GET', href }).pipe(
    Effect.map((reply) => ({
      href,
      etag: reply.headers.get('etag') ?? undefined,
      ics: reply.body,
    })),
  );

const calendarContentType = 'text/calendar; charset=utf-8';

export const createCalendarObject = (
  client: DavClient,
  href: string,
  ics: string,
): Effect.Effect<string | undefined, DavRequestError> =>
  createResource(client, { href, body: ics, contentType: calendarContentType });

export const replaceCalendarObject = (
  client: DavClient,
  href: string,
  ics: string,
  etag: string,
): Effect.Effect<string | undefined, DavRequestError> =>
  replaceResource(
    client,
    { href, body: ics, contentType: calendarContentType },
    etag,
  );

// Whether the server sends the invitations, updates, and cancellations for
// changes to the resource itself (RFC 6638, section 2).
export const schedulesFor = (
  client: DavClient,
  href: string,
): Effect.Effect<boolean, DavRequestError> =>
  client
    .send({ method: 'OPTIONS', href })
    .pipe(
      Effect.map((reply) =>
        (reply.headers.get('dav') ?? '')
          .split(',')
          .some((feature) => feature.trim() === 'calendar-auto-schedule'),
      ),
    );

// Without notifyAttendees, Schedule-Reply: F asks a scheduling server not
// to tell the organizer when an attendee deletes an invitation (RFC 6638,
// section 8.1).
export const deleteCalendarObject = (
  client: DavClient,
  href: string,
  etag: string,
  notifyAttendees: boolean,
): Effect.Effect<void, DavRequestError> =>
  deleteResource(
    client,
    href,
    etag,
    notifyAttendees ? {} : { 'schedule-reply': 'F' },
  );
