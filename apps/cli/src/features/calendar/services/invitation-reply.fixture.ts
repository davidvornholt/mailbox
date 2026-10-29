import {
  davResponse,
  multistatus,
} from '../../../shared/dav/dav-server.fixture';
import { calendarRoutes, type Routes, schedules } from './caldav-write.fixture';
import { icsOf, vevent } from './ical.fixture';
import { review } from './invitation.fixture';

export const copyHref = '/calendars/me/work/copy.ics';
export const newResource = /\/calendars\/me\/work\/[\w-]+\.ics$/u;

// The meeting as the user's calendar stores it, with their answer.
export const storedCopy = (partstat: string, ...extra: ReadonlyArray<string>) =>
  icsOf(...review('SEQUENCE:0'), ...extra).replace(
    'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
    `PARTSTAT=${partstat};RSVP=TRUE;CN=Me`,
  );

export const weekly = 'RRULE:FREQ=WEEKLY;COUNT=3';

// The stored meeting with more lines in its main event.
export const storedSeries = (
  partstat: string,
  ...lines: ReadonlyArray<string>
) =>
  storedCopy(partstat).replace(
    'SEQUENCE:0',
    ['SEQUENCE:0', ...lines].join('\r\n'),
  );

// The second of the weekly meetings, moved by the organizer.
export const occurrenceEvent = (partstat: string) =>
  vevent(
    'ORGANIZER;CN=Boss:mailto:boss@example.com',
    `ATTENDEE;PARTSTAT=${partstat};RSVP=TRUE;CN=Me:mailto:me@example.com`,
    'UID:review@example.com',
    'RECURRENCE-ID;TZID=W. Europe Standard Time:20261111T100000',
    'SUMMARY:Review',
    'DTSTART;TZID=W. Europe Standard Time:20261111T120000',
    'DTEND;TZID=W. Europe Standard Time:20261111T130000',
    'DTSTAMP:20261028T080000Z',
    'SEQUENCE:1',
  );

// The calendar data with one more event.
export const withOccurrence = (
  ics: string,
  event: ReadonlyArray<string>,
): string =>
  ics.replace('END:VCALENDAR', [...event, 'END:VCALENDAR'].join('\r\n'));

export const copies = (
  ...stored: ReadonlyArray<readonly [string, string]>
) => ({
  body: multistatus(
    ...stored.map(([at, ics]) =>
      davResponse(
        at,
        `<d:getetag>"c1"</d:getetag><c:calendar-data>${ics}</c:calendar-data>`,
      ),
    ),
  ),
});

export const routesWith = (
  report: Routes[string],
  more: Routes = {},
): Routes => ({
  ...calendarRoutes,
  'OPTIONS /calendars/me/work/': schedules,
  'REPORT /calendars/me/work/': report,
  ...more,
});

export const accept = { partstat: 'accepted', notifyOrganizer: true } as const;
