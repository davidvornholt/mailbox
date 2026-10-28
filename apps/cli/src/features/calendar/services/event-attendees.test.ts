import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import {
  attendeeChanges,
  newAttendees,
  otherAttendees,
} from './event-attendees';
import { vcalendarOf, vevent, weeklySeries } from './ical.fixture';

describe('otherAttendees', () => {
  it.each([
    ['no attendees', vevent('UID:a', 'ORGANIZER:mailto:me@example.com'), []],
    [
      'only the organizer',
      vevent(
        'UID:a',
        'ORGANIZER:mailto:me@example.com',
        'ATTENDEE:MAILTO:Me@Example.com',
      ),
      [],
    ],
    [
      "a guest whose address escapes a letter of the organizer's",
      vevent(
        'UID:a',
        'ORGANIZER:mailto:me@example.com',
        'ATTENDEE:mailto:%6De@example.com',
      ),
      ['%6de@example.com'],
    ],
    [
      'a guest',
      vevent(
        'UID:a',
        'ORGANIZER:mailto:me@example.com',
        'ATTENDEE:mailto:me@example.com',
        'ATTENDEE;CN=Ana:mailto:ana@example.com',
      ),
      ['ana@example.com'],
    ],
    [
      'an invitation from someone else',
      vevent(
        'UID:a',
        'ORGANIZER:mailto:boss@example.com',
        'ATTENDEE:mailto:me@example.com',
      ),
      ['me@example.com'],
    ],
    [
      'an attendee without an organizer',
      vevent('UID:a', 'ATTENDEE:mailto:me@example.com'),
      ['me@example.com'],
    ],
  ])('finds %s', (_name, event, expected) => {
    expect(otherAttendees(vcalendarOf(...event))).toEqual(expected);
  });

  it('checks every occurrence of a series', () => {
    expect(
      otherAttendees(
        vcalendarOf(
          ...weeklySeries,
          ...vevent(
            'UID:series@example.com',
            'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
            'DTSTART;TZID=Europe/Berlin:20261027T120000',
            'DTEND;TZID=Europe/Berlin:20261027T130000',
            'ATTENDEE:mailto:guest@example.com',
          ),
        ),
      ),
    ).toEqual(['guest@example.com']);
  });
});

describe('newAttendees', () => {
  const taken = new Set(['me@example.com']);

  it('keeps each new address once, as given', () => {
    expect(
      newAttendees(
        [' Ana@Example.com', 'ana@example.com', 'bo@example.org'],
        taken,
      ),
    ).toEqual(Result.succeed(['ana@example.com', 'bo@example.org']));
  });

  it.each([
    ['ana', '"ana" is not an email address'],
    ['ana@example.com\r\nATTENDEE:x', 'is not an email address'],
    ['Ana <ana@example.com>', 'is not an email address'],
    ['ana@example.com;ROLE=CHAIR', 'is not an email address'],
    [
      'Me@example.com',
      'Me@example.com is already the organizer or an attendee',
    ],
  ])('refuses %s', (email, reason) => {
    const result = newAttendees([email], taken);
    expect(Result.isFailure(result) && result.failure).toContain(reason);
  });
});

describe('attendeeChanges', () => {
  const master = vcalendarOf(
    ...vevent(
      'UID:a',
      'ORGANIZER:mailto:me@example.com',
      'ATTENDEE:mailto:ana@example.com',
    ),
  ).getFirstSubcomponent('vevent');

  it.each([
    [[], ['bo@example.org'], 'bo@example.org is not an attendee'],
    [['ANA@example.com'], [], 'is already the organizer or an attendee'],
    [['me@example.com'], [], 'is already the organizer or an attendee'],
    [['ana@example.com'], ['ana@example.com'], 'is already'],
  ])('refuses adding %j and removing %j', (add, remove, reason) => {
    const result =
      master === null
        ? Result.fail('no event')
        : attendeeChanges(master, add, remove);
    expect(Result.isFailure(result) && result.failure).toContain(reason);
  });
});
