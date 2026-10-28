import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import { unfolded } from './calendar-write.fixture';
import { parseCalendar } from './event-fields';
import { icsOf, vevent } from './ical.fixture';
import {
  giveAnswer,
  invitationReply,
  partiesOf,
  readInvitation,
  unansweredCopy,
} from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';

const nowMs = Date.parse('2026-10-28T09:15:00Z');

describe('readInvitation', () => {
  it('takes the method of the calendar data over the one in the MIME type', () => {
    expect(received(invitationIcs(...review()), 'PUBLISH')).toMatchObject({
      method: 'request',
      uid: 'review@example.com',
      sequence: 0,
    });
  });

  it('falls back to the MIME method and else to none', () => {
    const ics = icsOf(...review('SEQUENCE:2'));
    expect(received(ics, 'CANCEL')).toMatchObject({
      method: 'cancel',
      sequence: 2,
    });
    expect(received(ics, undefined)).not.toHaveProperty('method');
  });

  it('refuses an event without a UID', () => {
    const ics = invitationIcs(
      ...review().filter((line) => !line.startsWith('UID:')),
    );
    const error = Effect.runSync(
      Effect.flip(readInvitation('Message uid 7 in "INBOX"', ics, 'REQUEST')),
    );
    expect(error).toMatchObject({ _tag: 'CalendarDataError' });
  });
});

describe('partiesOf', () => {
  it('finds the attendee among the addresses in any case', () => {
    expect(
      partiesOf(received(), ['other@example.com', 'ME@example.com']),
    ).toEqual(
      Result.succeed({
        attendee: 'me@example.com',
        organizer: 'boss@example.com',
      }),
    );
  });

  it.each([
    ['a plain calendar file', received(icsOf(...review()), undefined), 'iTIP'],
    [
      'a cancellation',
      received(
        invitationIcs(...review()).replace('METHOD:REQUEST', 'METHOD:CANCEL'),
      ),
      'CANCEL',
    ],
    [
      'an invitation from the user',
      received(
        invitationIcs(...review()).replace(
          'boss@example.com',
          'me@example.com',
        ),
      ),
      'organizes',
    ],
    [
      'an invitation without an organizer',
      received(
        invitationIcs(
          ...review().filter((line) => !line.startsWith('ORGANIZER')),
        ),
      ),
      'no organizer',
    ],
    [
      'an invitation whose organizer is several addresses',
      received(
        invitationIcs(...review()).replace(
          'mailto:boss@example.com',
          'mailto:boss@example.com,extra@example.com',
        ),
      ),
      'single email address',
    ],
    [
      'an invitation for someone else',
      received(
        invitationIcs(...review()).replace('me@example.com', 'bo@example.com'),
      ),
      'does not invite me@example.com',
    ],
    [
      'a cancelled meeting',
      received(invitationIcs(...review()).replace('CONFIRMED', 'CANCELLED')),
      'cancelled',
    ],
  ])('refuses %s', (_name, invitation, reason) => {
    const parties = partiesOf(invitation, ['me@example.com']);
    expect(Result.isFailure(parties) && parties.failure).toContain(reason);
  });

  it('refuses an invitation for two of the addresses', () => {
    const parties = partiesOf(
      received(
        invitationIcs(
          ...review('ATTENDEE;PARTSTAT=ACCEPTED:mailto:alias@example.com'),
        ),
      ),
      ['alias@example.com', 'me@example.com'],
    );
    expect(Result.isFailure(parties) && parties.failure).toContain(
      'both me@example.com and alias@example.com',
    );
  });
});

describe('unansweredCopy', () => {
  it('stores the invitation without its method and with the answer open', () => {
    const answered = invitationIcs(...review())
      .replace(
        'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
        'PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Me',
      )
      .replace(
        'ORGANIZER;CN=Boss',
        'ORGANIZER;CN=Boss;SCHEDULE-FORCE-SEND=REPLY',
      );
    const copy = unfolded(unansweredCopy(received(answered), 'me@example.com'));
    expect(copy).not.toContain('METHOD');
    expect(copy).not.toContain('SCHEDULE-FORCE-SEND');
    expect(copy).toContain('PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me');
    expect(copy).toContain('TZID:W. Europe Standard Time');
    expect(copy).toContain('BEGIN:VALARM');
  });
});

describe('giveAnswer', () => {
  const stored = (...organizer: ReadonlyArray<string>) =>
    Effect.runSync(
      parseCalendar(
        '/calendars/me/work/r.ics',
        icsOf(
          ...vevent(
            'UID:r@example.com',
            'DTSTART:20261104T090000Z',
            ...organizer,
            'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com',
          ),
          ...vevent(
            'UID:r@example.com',
            'RECURRENCE-ID:20261111T090000Z',
            'DTSTART:20261111T100000Z',
            ...organizer,
            'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com',
          ),
        ),
      ),
    );

  it('answers every event and lets the server deliver it', () => {
    const object = stored(
      'ORGANIZER;SCHEDULE-AGENT=CLIENT:mailto:boss@example.com',
    );
    giveAnswer(object, 'me@example.com', {
      partstat: 'tentative',
      force: false,
    });
    const ics = object.vcalendar.toString();
    expect(ics.match(/PARTSTAT=TENTATIVE/gu)).toHaveLength(2);
    expect(ics).not.toContain('SCHEDULE-AGENT');
    expect(ics).not.toContain('SCHEDULE-FORCE-SEND');
  });

  it('forces the answer only on the main event', () => {
    const object = stored(
      'ORGANIZER;SCHEDULE-FORCE-SEND=REPLY:mailto:boss@example.com',
    );
    giveAnswer(object, 'me@example.com', { partstat: 'accepted', force: true });
    expect(object.master.toString()).toContain(
      'ORGANIZER;SCHEDULE-FORCE-SEND=REPLY:mailto:boss@example.com',
    );
    expect(object.overrides[0]?.toString()).not.toContain(
      'SCHEDULE-FORCE-SEND',
    );
  });
});

describe('invitationReply', () => {
  const parties = { attendee: 'me@example.com', organizer: 'boss@example.com' };

  it('answers only for the user and only the occurrences that invite them', () => {
    const invitation = received(
      invitationIcs(
        ...review(
          'SEQUENCE:1',
          'RRULE:FREQ=WEEKLY;COUNT=3',
          'ATTENDEE;SCHEDULE-STATUS=1.2:mailto:cy@example.com',
        ),
        ...vevent(
          'UID:review@example.com',
          'RECURRENCE-ID;TZID=W. Europe Standard Time:20261111T100000',
          'DTSTART;TZID=W. Europe Standard Time:20261111T120000',
          'DTEND;TZID=W. Europe Standard Time:20261111T130000',
          'ORGANIZER:mailto:boss@example.com',
          'ATTENDEE:mailto:ana@example.com',
        ),
      ),
    );
    const reply = invitationReply(invitation, parties, {
      name: 'Me',
      partstat: 'tentative',
      nowMs,
    });
    expect(reply).toMatchObject({
      to: 'boss@example.com',
      subject: 'Tentative: Review',
      text: 'Me has tentatively accepted this invitation.\n',
    });
    const ics = unfolded(reply.ics);
    expect(ics).toContain('METHOD:REPLY');
    expect(ics).toContain('TZID:W. Europe Standard Time');
    expect(ics).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=TENTATIVE;CN=Me:mailto:me@example.com',
    );
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('DTSTAMP:20261028T091500Z');
    expect(ics?.match(/BEGIN:VEVENT/gu)).toHaveLength(1);
    for (const left of [
      'ana@example.com',
      'cy@example.com',
      'RSVP',
      'DESCRIPTION',
      'LOCATION',
      'RRULE:FREQ=WEEKLY',
      'VALARM',
      'DTSTAMP:20261028T080000Z',
    ]) {
      expect(ics).not.toContain(left);
    }
  });

  it('signs with the address when the account has no name', () => {
    expect(
      invitationReply(received(), parties, {
        name: ' ',
        partstat: 'declined',
        nowMs,
      }),
    ).toMatchObject({
      subject: 'Declined: Review',
      text: 'me@example.com has declined this invitation.\n',
    });
  });
});
