import {
  davResponse,
  multistatus,
} from '../../../shared/dav/dav-server.fixture';
import {
  calendarRoutes,
  type Routes,
  schedules,
} from './calendar-write.fixture';
import { icsOf } from './ical.fixture';
import { review } from './invitation.fixture';

export const copyHref = '/calendars/me/work/copy.ics';
export const newResource = /\/calendars\/me\/work\/[\w-]+\.ics$/u;

// The meeting as the user's calendar stores it, with their answer.
export const storedCopy = (partstat: string, ...extra: ReadonlyArray<string>) =>
  icsOf(...review('SEQUENCE:0'), ...extra).replace(
    'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
    `PARTSTAT=${partstat};RSVP=TRUE;CN=Me`,
  );

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
