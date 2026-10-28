import { Effect } from 'effect';
import { icsOf, vevent } from './ical.fixture';
import { type ReceivedInvitation, readInvitation } from './invitation';

// The time zone an Exchange invitation names by its Windows ID.
const westEurope = [
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

// A meeting Boss invites Me and Ana to, shaped like an Exchange invitation.
export const review = (...extra: ReadonlyArray<string>) =>
  vevent(
    'ORGANIZER;CN=Boss:mailto:boss@example.com',
    'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me:mailto:me@example.com',
    'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ana:mailto:ana@example.com',
    'DESCRIPTION;LANGUAGE=en-US:Agenda',
    'UID:review@example.com',
    'SUMMARY;LANGUAGE=en-US:Review',
    'DTSTART;TZID=W. Europe Standard Time:20261104T100000',
    'DTEND;TZID=W. Europe Standard Time:20261104T110000',
    'DTSTAMP:20261028T080000Z',
    'STATUS:CONFIRMED',
    'LOCATION;LANGUAGE=en-US:Room 1',
    ...extra,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:REMINDER',
    'TRIGGER;RELATED=START:-PT15M',
    'END:VALARM',
  );

// The calendar data of an invitation email.
export const invitationIcs = (...lines: ReadonlyArray<string>) =>
  icsOf('METHOD:REQUEST', ...westEurope, ...lines);

export const received = (
  ics: string = invitationIcs(...review('SEQUENCE:0')),
  mimeMethod?: string,
): ReceivedInvitation =>
  Effect.runSync(readInvitation('Message uid 7 in "INBOX"', ics, mimeMethod));
