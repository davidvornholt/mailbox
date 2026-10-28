import { Schema } from 'effect';

export class CalendarDataError extends Schema.TaggedError<CalendarDataError>()(
  'CalendarDataError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

export class CalendarNotFoundError extends Schema.TaggedError<CalendarNotFoundError>()(
  'CalendarNotFoundError',
  {
    calendar: Schema.String,
    message: Schema.String,
  },
) {}

export class ReadOnlyCalendarError extends Schema.TaggedError<ReadOnlyCalendarError>()(
  'ReadOnlyCalendarError',
  {
    calendar: Schema.String,
    message: Schema.String,
  },
) {}

// The write would make the server email attendees (RFC 6638), and the user
// did not ask to notify them or does not organize the meeting.
export class EventHasAttendeesError extends Schema.TaggedError<EventHasAttendeesError>()(
  'EventHasAttendeesError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

// A change pim does not make to this event, such as moving a recurring
// series.
export class EventChangeError extends Schema.TaggedError<EventChangeError>()(
  'EventChangeError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

// The server would not send the invitations pim asks for, or pim cannot
// tell from which address.
export class SchedulingUnsupportedError extends Schema.TaggedError<SchedulingUnsupportedError>()(
  'SchedulingUnsupportedError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}
