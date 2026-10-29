import { describe, expect, it } from 'bun:test';
import {
  davAccount,
  failsOnFakeDav,
  succeedsOnFakeDav,
  writeRequests,
} from '../../../shared/dav/dav-server.fixture';
import {
  createCalDavEvent,
  deleteCalDavEvent,
  updateCalDavEvent,
} from './caldav-write';
import {
  calendarRoutes,
  eventRoutes,
  href,
  invitation,
  meeting,
  noScheduling,
  type Routes,
  schedules,
  single,
  target,
  trip,
  unfolded,
} from './caldav-write.fixture';
import { berlin, icsOf, vevent } from './ical.fixture';

describe('createEvent with attendees', () => {
  const invite = {
    calendar: 'Work',
    ...trip,
    attendees: ['ana@example.com'],
    notifyAttendees: true,
  };
  const inviteRoutes: Routes = {
    ...calendarRoutes,
    'OPTIONS /calendars/me/work/': schedules,
    'PUT /calendars/me/work/*': { status: 201 },
  };

  it('invites the attendees as the user and reports how the server delivered each invitation', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      {
        ...inviteRoutes,
        'GET /calendars/me/work/*': {
          status: 200,
          headers: { etag: '"e2"' },
          body: icsOf(
            ...vevent(
              'UID:stored@example.com',
              'DTSTAMP:20261028T091500Z',
              'SUMMARY:Trip',
              'DTSTART;VALUE=DATE:20261030',
              'DTEND;VALUE=DATE:20261101',
              'ORGANIZER;CN=Me:mailto:me@example.com',
              'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;SCHEDULE-STATUS=1.2:mailto:ana@example.com',
            ),
          ),
        },
      },
      createCalDavEvent(davAccount, invite, berlin),
    );
    const [put] = writeRequests(requests);
    expect(unfolded(put?.body)).toContain(
      'ORGANIZER;CN=Me:mailto:me@example.com',
    );
    expect(unfolded(put?.body)).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com',
    );
    expect(value).toMatchObject({
      etag: '"e2"',
      organizer: { email: 'me@example.com', name: 'Me' },
      attendees: [
        {
          email: 'ana@example.com',
          partstat: 'needs-action',
          scheduleStatus: '1.2',
        },
      ],
    });
  });

  it('prints the invitation it wrote when the server does not return it', async () => {
    const { value } = await succeedsOnFakeDav(
      inviteRoutes,
      createCalDavEvent(davAccount, invite, berlin),
    );
    expect(value).toMatchObject({
      summary: 'Trip',
      attendees: [{ email: 'ana@example.com', partstat: 'needs-action' }],
    });
    expect(value).not.toHaveProperty('etag');
  });

  it.each([
    [
      'without --notify-attendees',
      inviteRoutes,
      { notifyAttendees: false },
      'EventHasAttendeesError',
    ],
    [
      'on a server that does not send invitations',
      { ...inviteRoutes, 'OPTIONS /calendars/me/work/': noScheduling },
      {},
      'SchedulingUnsupportedError',
    ],
    [
      'for the user themselves',
      inviteRoutes,
      { attendees: ['ME@example.com'] },
      'EventChangeError',
    ],
    [
      'for an address pim cannot write',
      inviteRoutes,
      { attendees: ['ana@example.com\r\nATTENDEE:mailto:bo@example.org'] },
      'EventChangeError',
    ],
  ])('refuses an invitation %s', async (_name, routes, change, tag) => {
    const { error, requests } = await failsOnFakeDav(
      routes,
      createCalDavEvent(davAccount, { ...invite, ...change }, berlin),
    );
    expect(error).toMatchObject({ _tag: tag });
    expect(writeRequests(requests)).toEqual([]);
  });
});

// A meeting whose last message to Ana failed (RFC 6638, section 3.2.9).
const undelivered = meeting.map((line) =>
  line.replace('PARTSTAT=ACCEPTED', 'PARTSTAT=ACCEPTED;SCHEDULE-STATUS=5.1'),
);

describe('updateEvent of a meeting', () => {
  const stored = (...lines: ReadonlyArray<string>): Routes => ({
    ...eventRoutes(icsOf(...meeting)),
    [`GET ${href}`]: [
      { status: 200, body: icsOf(...meeting), headers: { etag: '"v1"' } },
      {
        status: 200,
        body: icsOf(...vevent('UID:m@example.com', ...lines)),
        headers: { etag: '"v2"' },
      },
    ],
    [`PUT ${href}`]: { status: 204 },
  });

  it('moves a meeting the user organizes and asks the attendees to reply again', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      stored(
        'DTSTART:20261029T090000Z',
        'DTEND:20261029T100000Z',
        'ORGANIZER:mailto:me@example.com',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION;SCHEDULE-STATUS=1.2:mailto:ana@example.com',
      ),
      updateCalDavEvent(
        davAccount,
        target({ notifyAttendees: true }),
        { start: { _tag: 'Instant', ms: Date.parse('2026-10-29T09:00:00Z') } },
        berlin,
      ),
    );
    const [put] = writeRequests(requests);
    expect(put?.headers.get('if-match')).toBe('"v1"');
    expect(unfolded(put?.body)).toContain(
      'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com',
    );
    expect(value).toMatchObject({
      etag: '"v2"',
      attendees: [{ email: 'ana@example.com', scheduleStatus: '1.2' }],
    });
  });

  it('reports no delivery when it cannot read the event back', async () => {
    const { value } = await succeedsOnFakeDav(
      {
        ...eventRoutes(icsOf(...undelivered)),
        [`GET ${href}`]: [
          {
            status: 200,
            body: icsOf(...undelivered),
            headers: { etag: '"v1"' },
          },
          { status: 503 },
        ],
      },
      updateCalDavEvent(
        davAccount,
        target({ notifyAttendees: true }),
        { title: 'Renamed' },
        berlin,
      ),
    );
    expect(value).toMatchObject({ etag: '"v2"', summary: 'Renamed' });
    expect(value.attendees[1]).toEqual({
      email: 'ana@example.com',
      partstat: 'accepted',
    });
  });

  it('invites attendees to an event and makes the user its organizer', async () => {
    const { requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...single)),
      updateCalDavEvent(
        davAccount,
        target({ notifyAttendees: true }),
        { addAttendees: ['ana@example.com'] },
        berlin,
      ),
    );
    const [put] = writeRequests(requests);
    expect(unfolded(put?.body)).toContain(
      'ORGANIZER;CN=Me:mailto:me@example.com',
    );
    expect(unfolded(put?.body)).toContain('mailto:ana@example.com');
  });

  it('refuses to invite attendees without --notify-attendees', async () => {
    const { error, requests } = await failsOnFakeDav(
      eventRoutes(icsOf(...single)),
      updateCalDavEvent(
        davAccount,
        target(),
        { addAttendees: ['ana@example.com'] },
        berlin,
      ),
    );
    expect(error._tag).toBe('EventHasAttendeesError');
    expect(writeRequests(requests)).toEqual([]);
  });
});

describe('updateEvent of a meeting with a stored SCHEDULE-FORCE-SEND', () => {
  it('does not write it back', async () => {
    const forced = meeting.map((line) =>
      line.replace('ATTENDEE;', 'ATTENDEE;SCHEDULE-FORCE-SEND=REQUEST;'),
    );
    const { requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...forced)),
      updateCalDavEvent(
        davAccount,
        target({ notifyAttendees: true }),
        { title: 'Renamed' },
        berlin,
      ),
    );
    const [put] = writeRequests(requests);
    expect(put?.body).toContain('SUMMARY:Renamed');
    expect(put?.body).not.toContain('SCHEDULE-FORCE-SEND');
  });
});

describe('deleteEvent of a meeting', () => {
  it('cancels a meeting the user organizes with --notify-attendees', async () => {
    const { value, requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...undelivered)),
      deleteCalDavEvent(davAccount, target({ notifyAttendees: true }), berlin),
    );
    expect(value.attendees[1]).not.toHaveProperty('scheduleStatus');
    const [deletion] = writeRequests(requests);
    expect(deletion?.method).toBe('DELETE');
    expect(deletion?.headers.get('schedule-reply')).toBeNull();
  });

  it("deletes the user's copy of someone else's meeting without telling the organizer", async () => {
    const { value, requests } = await succeedsOnFakeDav(
      eventRoutes(icsOf(...invitation)),
      deleteCalDavEvent(davAccount, target(), berlin),
    );
    expect(value).toMatchObject({ organizer: { email: 'boss@example.com' } });
    const [deletion] = writeRequests(requests);
    expect(deletion?.method).toBe('DELETE');
    expect(deletion?.headers.get('if-match')).toBe('"v1"');
    expect(deletion?.headers.get('schedule-reply')).toBe('F');
  });

  it("refuses to decline someone else's meeting by deleting it", async () => {
    const { error, requests } = await failsOnFakeDav(
      eventRoutes(icsOf(...invitation)),
      deleteCalDavEvent(davAccount, target({ notifyAttendees: true }), berlin),
    );
    expect(error).toMatchObject({ _tag: 'EventHasAttendeesError' });
    expect(error.message).toContain('pim calendar respond');
    expect(writeRequests(requests)).toEqual([]);
  });
});
