import { Effect } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { DavClient } from '../../../shared/dav/client';
import { discoverPrincipal } from '../../../shared/dav/discovery';
import type { DavRequestError } from '../../../shared/errors/dav';
import {
  EventChangeError,
  EventHasAttendeesError,
  SchedulingUnsupportedError,
} from '../errors/errors';
import { schedulesFor } from './caldav';
import {
  type Organizer,
  organizerAddress,
  otherAttendees,
  unscheduledAttendees,
} from './event-attendees';
import type { CalendarObject } from './event-fields';

export type SchedulingError =
  | DavRequestError
  | EventChangeError
  | EventHasAttendeesError
  | SchedulingUnsupportedError;

// The user as the organizer of a meeting in the calendar at href, provided
// the server there sends the invitations itself. The organizer's address is
// one the server accepts as the user's, the account's own if it is one.
export const meetingOrganizer = (
  client: DavClient,
  account: Account,
  href: string,
): Effect.Effect<
  { readonly organizer: Organizer; readonly addresses: ReadonlyArray<string> },
  SchedulingError
> =>
  Effect.gen(function* () {
    const { host } = new URL(client.login.url);
    if (!(yield* schedulesFor(client, href))) {
      return yield* new SchedulingUnsupportedError({
        href,
        message: `${host} does not send invitations for ${href} (RFC 6638), so pim adds no attendees there and changes no meetings`,
      });
    }
    const principal = yield* discoverPrincipal(client);
    const addresses = principal.addresses.map((address) =>
      address.toLowerCase(),
    );
    const own = account.email.toLowerCase();
    const email = addresses.includes(own) ? own : addresses[0];
    if (email === undefined) {
      return yield* new SchedulingUnsupportedError({
        href,
        message: `${host} names no email address for ${account.email} in invitations (calendar-user-address-set), so pim cannot organize meetings there`,
      });
    }
    return { organizer: { email, name: account.name }, addresses };
  });

// A write to an existing event that the server could turn into email.
export type EventWrite = {
  readonly href: string;
  readonly object: CalendarObject;
  readonly invites: boolean;
  readonly notifyAttendees: boolean;
};

// Why pim does not change the meeting although the user asked to notify its
// attendees: someone else organizes it, or the server would not email some
// attendees.
const meetingRefusal = (
  account: Account,
  { href, object }: Pick<EventWrite, 'href' | 'object'>,
  addresses: ReadonlyArray<string>,
): EventHasAttendeesError | SchedulingUnsupportedError | undefined => {
  const events = [object.master, ...object.overrides];
  const other = events
    .map((event) => organizerAddress(event))
    .find((address) => address !== undefined && !addresses.includes(address));
  const unorganized = events.some(
    (event) =>
      organizerAddress(event) === undefined && event.hasProperty('attendee'),
  );
  if (other !== undefined || unorganized) {
    return new EventHasAttendeesError({
      href,
      message: `${href} is a meeting organized by ${other ?? 'no one'}, not by ${account.email}. pim changes only meetings the user organizes; the user can reply to it in a calendar app`,
    });
  }
  const unscheduled = unscheduledAttendees(object.vcalendar);
  return unscheduled.length === 0
    ? undefined
    : new SchedulingUnsupportedError({
        href,
        message: `The server does not email ${unscheduled.join(', ')} about ${href}, as a calendar app handles that (SCHEDULE-AGENT, RFC 6638). pim changes no such meeting; the user can change it in that app`,
      });
};

// The organizer the server emails the attendees as, when the write makes it
// email them. pim makes such a write only when the user asked to notify the
// attendees and organizes the meeting.
export const writeOrganizer = (
  client: DavClient,
  account: Account,
  { href, object, invites, notifyAttendees }: EventWrite,
): Effect.Effect<Organizer | undefined, SchedulingError> =>
  Effect.gen(function* () {
    const attendees = otherAttendees(object.vcalendar);
    if (attendees.length === 0 && !invites) {
      return notifyAttendees
        ? yield* new EventChangeError({
            href,
            message: `${href} has no attendees to notify; leave out --notify-attendees`,
          })
        : undefined;
    }
    if (!notifyAttendees) {
      return yield* new EventHasAttendeesError({
        href,
        message:
          attendees.length === 0
            ? `Inviting attendees to ${href} makes the server email them an invitation. Pass --notify-attendees only if the user asked to invite them`
            : `${href} is a meeting with ${attendees.join(', ')}. Changing or deleting it makes the server email them. Pass --notify-attendees only if the user asked to tell them`,
      });
    }
    const { organizer, addresses } = yield* meetingOrganizer(
      client,
      account,
      href,
    );
    const refusal = meetingRefusal(account, { href, object }, addresses);
    if (refusal !== undefined) {
      return yield* refusal;
    }
    return organizer;
  });
