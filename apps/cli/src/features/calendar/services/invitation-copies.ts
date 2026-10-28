import type { DateTime } from 'effect';
import { Effect } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { Dav } from '../../../shared/dav/dav';
import { discoverPrincipal } from '../../../shared/dav/discovery';
import type { DavRequestError } from '../../../shared/errors/dav';
import type { CalendarDataError } from '../errors/errors';
import type { Calendar, EventDetail } from '../schemas/calendar';
import {
  type CalendarResource,
  listCalendars,
  queryEventsByUid,
} from './caldav';
import { type CalendarError, readEvent } from './calendar';
import {
  type CalendarObject,
  eventDetail,
  parseCalendar,
  text,
} from './event-fields';
import { answerOf, ownAttendee, type ReceivedInvitation } from './invitation';

const calendarConcurrency = 4;

// The event in one of the user's calendars.
export type EventCopy = {
  readonly calendar: Calendar;
  readonly resource: CalendarResource;
  readonly object: CalendarObject;
};

export const findCopies = (
  client: DavClient,
  calendars: ReadonlyArray<Calendar>,
  uid: string,
): Effect.Effect<
  ReadonlyArray<EventCopy>,
  DavRequestError | CalendarDataError
> =>
  Effect.forEach(
    calendars,
    (calendar) =>
      queryEventsByUid(client, calendar.href, uid).pipe(
        Effect.flatMap((resources) =>
          Effect.forEach(resources, (found) =>
            Effect.fromResult(found).pipe(
              Effect.flatMap((resource) =>
                parseCalendar(resource.href, resource.ics).pipe(
                  Effect.map((object) => ({ calendar, resource, object })),
                ),
              ),
            ),
          ),
        ),
      ),
    { concurrency: calendarConcurrency },
  ).pipe(
    Effect.map((perCalendar) =>
      perCalendar
        .flat()
        .filter(({ object }) => text(object.master, 'uid') === uid),
    ),
  );

export const writable = (
  calendars: ReadonlyArray<Calendar>,
): ReadonlyArray<Calendar> =>
  calendars.filter((calendar) => calendar.writable !== false);

export type InvitationView = {
  readonly method?: string;
  readonly sequence: number;
  // The address the invitation invites the user as.
  readonly attendee?: string;
  readonly event: Omit<EventDetail, 'account' | 'href' | 'etag' | 'ics'>;
  // The event in the user's calendars, with their answer there. Only
  // accounts with calendars have them.
  readonly copies?: ReadonlyArray<{
    readonly calendar: string;
    readonly href: string;
    readonly etag?: string;
    readonly partstat?: string;
  }>;
};

export const describeInvitation = (
  account: Account,
  invitation: ReceivedInvitation,
  local: DateTime.TimeZone,
): Effect.Effect<InvitationView, CalendarError | CalendarDataError, Dav> =>
  Effect.gen(function* () {
    const {
      account: _account,
      href: _href,
      etag: _etag,
      ...event
    } = yield* readEvent(invitation.source, () =>
      eventDetail(
        invitation.object,
        { account: account.email, href: invitation.source, etag: undefined },
        local,
      ),
    );
    const view = {
      ...(invitation.method === undefined ? {} : { method: invitation.method }),
      sequence: invitation.sequence,
      event,
    };
    if (account.dav === undefined) {
      const attendee = ownAttendee(invitation.object, [account.email]);
      return { ...view, ...(attendee === undefined ? {} : { attendee }) };
    }
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const principal = yield* discoverPrincipal(client);
    const attendee = ownAttendee(invitation.object, [
      account.email,
      ...principal.addresses,
    ]);
    const calendars = writable(yield* listCalendars(client));
    const copies = yield* findCopies(client, calendars, invitation.uid);
    return {
      ...view,
      ...(attendee === undefined ? {} : { attendee }),
      copies: copies.map(({ calendar, resource, object }) => {
        const partstat =
          attendee === undefined ? undefined : answerOf(object, attendee);
        return {
          calendar: calendar.name,
          href: resource.href,
          ...(resource.etag === undefined ? {} : { etag: resource.etag }),
          ...(partstat === undefined ? {} : { partstat }),
        };
      }),
    };
  });
