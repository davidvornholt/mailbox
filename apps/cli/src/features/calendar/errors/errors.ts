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
