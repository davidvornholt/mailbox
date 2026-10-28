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

// The event has attendees other than its organizer. Changing or deleting it
// can make the server email them (RFC 6638), so pim refuses.
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
