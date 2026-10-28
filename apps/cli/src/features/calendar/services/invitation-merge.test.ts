import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import { unfolded } from './calendar-write.fixture';
import { parseCalendar } from './event-fields';
import type { ReceivedInvitation } from './invitation';
import { invitationIcs, received, review } from './invitation.fixture';
import { importChange } from './invitation-merge';
import {
  copyHref,
  occurrenceEvent,
  storedCopy,
  storedSeries,
  weekly,
  withOccurrence,
} from './invitation-reply.fixture';

const changeOf = (invitation: ReceivedInvitation, stored?: string) =>
  importChange(
    invitation,
    ['me@example.com'],
    stored === undefined
      ? undefined
      : {
          href: copyHref,
          object: Effect.runSync(parseCalendar(copyHref, stored)),
        },
  );

// The copy as the message changes it.
const changed = (invitation: ReceivedInvitation, stored: string) => {
  const change = changeOf(invitation, stored);
  if (Result.isFailure(change) || change.success._tag !== 'Change') {
    throw new Error(`The message should change the copy: ${String(change)}`);
  }
  return unfolded(change.success.vcalendar.toString()) ?? '';
};

const cancellation = (...lines: ReadonlyArray<string>) =>
  received(invitationIcs(...lines).replace('METHOD:REQUEST', 'METHOD:CANCEL'));

const myAnswer = /PARTSTAT=(?<partstat>[A-Z-]+);RSVP=TRUE;CN=Me/gu;

const answers = (ics: string) =>
  [...ics.matchAll(myAnswer)].map((match) => match.groups?.partstat);

describe('importChange of an invitation', () => {
  it('adds a new meeting without its method and with the answer open', () => {
    const change = changeOf(
      received(
        invitationIcs(...review('SEQUENCE:0')).replace(
          'PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me',
          'PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Me',
        ),
      ),
    );
    if (Result.isFailure(change) || change.success._tag !== 'Create') {
      throw new Error('The invitation should add the meeting');
    }
    const ics = unfolded(change.success.ics) ?? '';
    expect(ics).not.toContain('METHOD');
    expect(answers(ics)).toEqual(['NEEDS-ACTION']);
  });

  it('keeps the answer and reminders when the organizer changes details only', () => {
    const ics = changed(
      received(
        invitationIcs(
          ...review('SEQUENCE:0', 'COMMENT:Moved rooms').map((line) =>
            line === 'DTSTAMP:20261028T080000Z'
              ? 'DTSTAMP:20261029T080000Z'
              : line,
          ),
        ),
      ),
      storedCopy('ACCEPTED').replace(
        'TRIGGER;RELATED=START:-PT15M',
        'TRIGGER:-PT1H',
      ),
    );
    expect(answers(ics)).toEqual(['ACCEPTED']);
    expect(ics).toContain('COMMENT:Moved rooms');
    expect(ics).toContain('TRIGGER:-PT1H');
    expect(ics).not.toContain('-PT15M');
  });

  it('opens the answer again when the organizer raises the sequence', () => {
    const ics = changed(
      received(invitationIcs(...review('SEQUENCE:1'))),
      storedCopy('ACCEPTED'),
    );
    expect(answers(ics)).toEqual(['NEEDS-ACTION']);
    expect(ics).toContain('SEQUENCE:1');
  });

  it('adds a changed occurrence with the answer it needs and includes it again', () => {
    const ics = changed(
      received(invitationIcs(...occurrenceEvent('NEEDS-ACTION'))),
      storedSeries(
        'ACCEPTED',
        weekly,
        'EXDATE;TZID=W. Europe Standard Time:20261111T100000',
      ),
    );
    expect(answers(ics)).toEqual(['ACCEPTED', 'NEEDS-ACTION']);
    expect(ics).not.toContain('EXDATE');
    expect(ics).toContain('BEGIN:VTIMEZONE');
  });
});

describe('importChange of a cancellation', () => {
  it.each([
    ['without a changed version of it', storedSeries('ACCEPTED', weekly)],
    [
      'with a changed version of it',
      withOccurrence(
        storedSeries('ACCEPTED', weekly),
        occurrenceEvent('ACCEPTED'),
      ),
    ],
  ])('excludes a cancelled occurrence from a series %s', (_name, stored) => {
    const ics = changed(
      cancellation(...occurrenceEvent('NEEDS-ACTION')),
      stored,
    );
    expect(ics).toContain(
      'EXDATE;TZID=W. Europe Standard Time:20261111T100000',
    );
    expect(ics).not.toContain('RECURRENCE-ID');
    expect(ics).not.toContain('CANCELLED');
  });

  it('marks every event of a cancelled meeting cancelled', () => {
    const ics = changed(
      cancellation(...review('SEQUENCE:1')),
      withOccurrence(
        storedSeries('ACCEPTED', weekly),
        occurrenceEvent('ACCEPTED'),
      ),
    );
    expect(ics.match(/STATUS:CANCELLED/gu)).toHaveLength(2);
    expect(ics.match(/SEQUENCE:1/gu)).toHaveLength(2);
  });
});

describe('importChange of a message the copy holds', () => {
  it('finishes a copy that pim stopped writing halfway', () => {
    const ics = changed(
      received(),
      storedCopy('NEEDS-ACTION').replace(
        'ORGANIZER;CN=Boss',
        'ORGANIZER;CN=Boss;SCHEDULE-AGENT=CLIENT',
      ),
    );
    expect(ics).not.toContain('SCHEDULE-AGENT');
  });

  it.each([
    [
      'an invitation the copy already holds',
      received(),
      storedCopy('ACCEPTED'),
    ],
    [
      'an older invitation',
      received(),
      storedCopy('ACCEPTED').replace('SEQUENCE:0', 'SEQUENCE:2'),
    ],
    [
      'an older cancellation',
      cancellation(...review('SEQUENCE:1')),
      storedCopy('ACCEPTED').replace('SEQUENCE:0', 'SEQUENCE:2'),
    ],
    [
      'a cancellation the copy already holds',
      cancellation(...review('SEQUENCE:0')),
      storedCopy('ACCEPTED').replace('STATUS:CONFIRMED', 'STATUS:CANCELLED'),
    ],
  ])('leaves the copy as it is for %s', (_name, invitation, stored) => {
    expect(changeOf(invitation, stored)).toEqual(
      Result.succeed({ _tag: 'Current' }),
    );
  });

  it('adds nothing for a cancellation of a meeting the calendar does not hold', () => {
    expect(changeOf(cancellation(...review('SEQUENCE:0')))).toEqual(
      Result.succeed({ _tag: 'Absent' }),
    );
  });
});

describe('importChange refusals', () => {
  it.each([
    [
      'a reply',
      received(
        invitationIcs(...review()).replace('METHOD:REQUEST', 'METHOD:REPLY'),
      ),
      'REPLY',
    ],
    [
      "the user's own meeting",
      received(
        invitationIcs(...review()).replace(
          'mailto:boss@example.com',
          'mailto:me@example.com',
        ),
      ),
      'pim calendar update',
    ],
    [
      'a change to an occurrence and all later ones',
      received(
        invitationIcs(
          ...occurrenceEvent('NEEDS-ACTION').map((line) =>
            line.replace(
              'RECURRENCE-ID;',
              'RECURRENCE-ID;RANGE=THISANDFUTURE;',
            ),
          ),
        ),
      ),
      'RANGE',
    ],
  ])('refuses %s', (_name, invitation, reason) => {
    const change = changeOf(invitation, storedCopy('ACCEPTED'));
    expect(Result.isFailure(change) && change.failure).toContain(reason);
  });

  it('leaves a meeting with the same UID from another organizer unchanged', () => {
    const change = changeOf(
      received(),
      storedCopy('ACCEPTED').replace('boss@example.com', 'other@example.com'),
    );
    expect(Result.isFailure(change) && change.failure).toContain(
      'other@example.com organizes, not boss@example.com',
    );
  });
});
