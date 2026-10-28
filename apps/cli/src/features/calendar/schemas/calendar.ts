export type Calendar = {
  readonly account: string;
  readonly href: string;
  readonly name: string;
  readonly description?: string;
  readonly color?: string;
  // False when the user may only read the calendar, as with a shared one.
  readonly writable?: boolean;
};

// Times are local ISO date-times with offset. All-day events give dates
// instead, and their end is the last day of the event.
export type EventSummary = {
  readonly account: string;
  readonly calendar: string;
  readonly href: string;
  readonly uid: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly status?: string;
  // Set on each occurrence of a recurring event.
  readonly recurrenceId?: string;
  readonly organizer?: string;
  readonly attendees?: number;
};

export type Attendee = {
  readonly email: string;
  readonly name?: string;
  readonly role?: string;
  readonly partstat?: string;
  readonly rsvp?: boolean;
  // How the server delivered the organizer's last message to the attendee,
  // such as 1.1 for sent (RFC 6638, section 3.2.9). Servers may leave it out.
  readonly scheduleStatus?: string;
};

export type EventChange = {
  readonly recurrenceId: string;
  readonly start: string;
  readonly end: string;
  readonly summary?: string;
  readonly status?: string;
  readonly location?: string;
  // Set when the occurrence has other attendees than the series.
  readonly attendees?: ReadonlyArray<string>;
};

export type EventDetail = {
  readonly account: string;
  readonly href: string;
  readonly etag?: string;
  readonly uid: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly timeZone?: string;
  readonly location?: string;
  readonly description?: string;
  readonly url?: string;
  readonly status?: string;
  readonly organizer?: {
    readonly email: string;
    readonly name?: string;
    // How the server delivered the user's last answer to the organizer
    // (RFC 6638, section 3.2.9).
    readonly scheduleStatus?: string;
  };
  readonly attendees: ReadonlyArray<Attendee>;
  // The RRULE, such as FREQ=WEEKLY;BYDAY=MO, with the dates it skips and the
  // occurrences that differ from it. A series of RDATEs has no rule.
  readonly recurrence?: {
    readonly rule?: string;
    readonly excluded: ReadonlyArray<string>;
    readonly changed: ReadonlyArray<EventChange>;
  };
  readonly ics?: string;
};
