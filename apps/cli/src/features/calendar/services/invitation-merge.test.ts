import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import { unfolded } from './caldav-write.fixture';
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

// The copy after each message in turn, each of which changes it.
const replayed = (
  stored: string,
  ...messages: ReadonlyArray<ReceivedInvitation>
): string => messages.reduce((ics, message) => changed(message, ics), stored);

// The moved occurrence at another SEQUENCE.
const occurrenceAt = (sequence: number, partstat = 'NEEDS-ACTION') =>
  occurrenceEvent(partstat).map((line) =>
    line === 'SEQUENCE:1' ? `SEQUENCE:${sequence}` : line,
  );

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

  it.each([
    'EXDATE;TZID=W. Europe Standard Time:20261111T100000',
    'EXDATE:20261111T090000Z',
  ])(
    'adds a changed occurrence with the answer it needs and includes it again after %s',
    (exdate) => {
      const ics = changed(
        received(invitationIcs(...occurrenceEvent('NEEDS-ACTION'))),
        storedSeries('ACCEPTED', weekly, exdate),
      );
      expect(answers(ics)).toEqual(['ACCEPTED', 'NEEDS-ACTION']);
      expect(ics).not.toContain('EXDATE');
      expect(ics).toContain('BEGIN:VTIMEZONE');
    },
  );

  it('replaces a changed occurrence the copy names in another time zone', () => {
    const ics = changed(
      received(invitationIcs(...occurrenceAt(2))),
      withOccurrence(
        storedSeries('ACCEPTED', weekly),
        occurrenceEvent('ACCEPTED').map((line) =>
          line.startsWith('RECURRENCE-ID')
            ? 'RECURRENCE-ID:20261111T090000Z'
            : line,
        ),
      ),
    );
    expect(answers(ics)).toEqual(['ACCEPTED', 'NEEDS-ACTION']);
  });
});

describe('importChange of a series the copy holds changed occurrences of', () => {
  it('keeps a changed occurrence newer than the series, with its answer and reminders', () => {
    const ics = changed(
      received(invitationIcs(...review('SEQUENCE:1', weekly))),
      withOccurrence(
        storedSeries('ACCEPTED', weekly),
        occurrenceAt(3, 'DECLINED').flatMap((line) =>
          line === 'END:VEVENT'
            ? [
                'BEGIN:VALARM',
                'ACTION:DISPLAY',
                'DESCRIPTION:Mine',
                'TRIGGER:-PT2H',
                'END:VALARM',
                line,
              ]
            : [line],
        ),
      ),
    );
    expect(answers(ics)).toHaveLength(2);
    expect(answers(ics)).toContain('DECLINED');
    expect(ics).toContain('SEQUENCE:3');
    expect(ics).toContain('DESCRIPTION:Mine');
  });

  it('takes a newer changed occurrence along with a series the copy holds', () => {
    const ics = changed(
      received(
        invitationIcs(...review('SEQUENCE:0', weekly), ...occurrenceAt(2)),
      ),
      withOccurrence(
        storedSeries('ACCEPTED', weekly),
        occurrenceEvent('ACCEPTED'),
      ),
    );
    expect(answers(ics)).toEqual(['ACCEPTED', 'NEEDS-ACTION']);
    expect(ics).toContain('SEQUENCE:2');
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
      'EXDATE;TZID=W. Europe Standard Time;X-PIM-SEQUENCE=1:20261111T100000',
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

const unchangedCopies: ReadonlyArray<
  readonly [string, ReceivedInvitation, string]
> = [
  ['an invitation the copy already holds', received(), storedCopy('ACCEPTED')],
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
  [
    'a cancellation of an occurrence older than the series',
    cancellation(...occurrenceEvent('NEEDS-ACTION')),
    storedSeries('ACCEPTED', weekly).replace('SEQUENCE:0', 'SEQUENCE:3'),
  ],
  [
    'an older invitation to an occurrence the copy excludes',
    received(invitationIcs(...occurrenceEvent('NEEDS-ACTION'))),
    replayed(
      withOccurrence(
        storedSeries('ACCEPTED', weekly),
        occurrenceEvent('ACCEPTED'),
      ),
      cancellation(...occurrenceAt(2)),
    ),
  ],
  [
    'a cancellation of an occurrence older than its changed version',
    cancellation(...occurrenceEvent('NEEDS-ACTION')),
    withOccurrence(
      storedSeries('ACCEPTED', weekly),
      occurrenceEvent('ACCEPTED').map((line) =>
        line === 'DTSTAMP:20261028T080000Z' ? 'DTSTAMP:20261029T080000Z' : line,
      ),
    ),
  ],
  [
    'an invitation to an occurrence older than its cancellation, after a series update that excludes it',
    received(invitationIcs(...occurrenceAt(4))),
    replayed(
      storedSeries('ACCEPTED', weekly),
      cancellation(...occurrenceAt(5)),
      received(
        invitationIcs(
          ...review(
            'SEQUENCE:3',
            weekly,
            'EXDATE;TZID=W. Europe Standard Time:20261111T100000',
          ),
        ),
      ),
    ),
  ],
  [
    'an invitation to an occurrence older than its cancellation, after a series update that does not exclude it',
    received(invitationIcs(...occurrenceAt(6))),
    replayed(
      storedSeries(
        'ACCEPTED',
        weekly,
        'EXDATE;TZID=W. Europe Standard Time;X-PIM-SEQUENCE=7:20261111T100000',
        'EXDATE;TZID=W. Europe Standard Time;X-PIM-SEQUENCE=5:20261111T100000,20261118T100000',
      ),
      received(invitationIcs(...review('SEQUENCE:3', weekly))),
    ),
  ],
  [
    'an invitation older than a repeated cancellation',
    received(invitationIcs(...review('SEQUENCE:2'))),
    replayed(
      storedCopy('ACCEPTED'),
      cancellation(...review('SEQUENCE:1')),
      cancellation(...review('SEQUENCE:3')),
    ),
  ],
];

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

  it.each(unchangedCopies)(
    'leaves the copy as it is for %s',
    (_name, invitation, stored) => {
      expect(changeOf(invitation, stored)).toEqual(
        Result.succeed({ _tag: 'Current' }),
      );
    },
  );

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
