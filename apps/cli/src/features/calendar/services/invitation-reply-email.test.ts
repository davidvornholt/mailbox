import { describe, expect, it } from 'bun:test';
import { unfolded } from './calendar-write.fixture';
import { vevent } from './ical.fixture';
import { invitationIcs, received, review } from './invitation.fixture';
import { invitationReply } from './invitation-reply-email';

const nowMs = Date.parse('2026-10-28T09:15:00Z');

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
