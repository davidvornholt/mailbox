import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import type { CalendarDate } from './calendar-dates';
import {
  changedSpan,
  type EventSpan,
  type EventTime,
  parseEventTime,
  spanBetween,
} from './event-times';
import { berlin } from './ical.fixture';

const dayOf = (value: string): CalendarDate => {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return { year, month, day };
};

const date = (value: string): EventTime => ({
  _tag: 'Date',
  date: dayOf(value),
});

const instant = (iso: string): EventTime => ({
  _tag: 'Instant',
  ms: Date.parse(iso),
});

const days = (first: string, last: string): EventSpan => ({
  _tag: 'Days',
  first: dayOf(first),
  last: dayOf(last),
});

const times = (start: string, end: string): EventSpan => ({
  _tag: 'Times',
  startMs: Date.parse(start),
  endMs: Date.parse(end),
});

const failureOf = <A>(result: Result.Result<A, string>): string | undefined =>
  Result.isFailure(result) ? result.failure : undefined;

describe('parseEventTime', () => {
  it.each([
    ['2026-10-28', date('2026-10-28')],
    ['2026-10-28T14:30', instant('2026-10-28T13:30:00Z')],
    ['2026-07-01T10:00:15', instant('2026-07-01T08:00:15Z')],
    ['2026-10-28T14:30:00+05:30', instant('2026-10-28T09:00:00Z')],
    ['2026-10-28T14:30:00-03:00', instant('2026-10-28T17:30:00Z')],
    ['2026-10-28T14:30Z', instant('2026-10-28T14:30:00Z')],
  ])('reads %p', (value, expected) => {
    expect(parseEventTime(value, berlin)).toEqual(Result.succeed(expected));
  });

  it.each([
    ['2026-02-30', 'is not a real date'],
    ['2026-02-30T10:00', 'is not a real date and time'],
    ['2026-10-28T24:00', 'is not a real date and time'],
    ['2026-10-28T10:00+15:00', 'has an invalid UTC offset +15:00'],
    ['2026-10-28T10:00+01:60', 'has an invalid UTC offset +01:60'],
    ['2026-10-28 10:00', 'must be a date like'],
    ['tomorrow', 'must be a date like'],
    // Berlin skips 02:00 to 03:00 on 2026-03-29 and repeats 02:00 to 03:00
    // on 2026-10-25.
    ['2026-03-29T02:30', 'does not exist or occurs twice in Europe/Berlin'],
    ['2026-10-25T02:30', 'does not exist or occurs twice in Europe/Berlin'],
  ])('refuses %p', (value, reason) => {
    expect(failureOf(parseEventTime(value, berlin))).toContain(reason);
  });

  it('reads a repeated time with its offset', () => {
    expect(parseEventTime('2026-10-25T02:30:00+01:00', berlin)).toEqual(
      Result.succeed(instant('2026-10-25T01:30:00Z')),
    );
  });
});

describe('spanBetween', () => {
  it.each([
    [
      'an all-day event to its start day',
      date('2026-10-28'),
      undefined,
      days('2026-10-28', '2026-10-28'),
    ],
    [
      'an all-day event to its last day',
      date('2026-10-28'),
      date('2026-10-30'),
      days('2026-10-28', '2026-10-30'),
    ],
    [
      'a timed event',
      instant('2026-10-28T10:00:00Z'),
      instant('2026-10-28T11:00:00Z'),
      times('2026-10-28T10:00:00Z', '2026-10-28T11:00:00Z'),
    ],
  ])('spans %s', (_name, start, end, expected) => {
    expect(spanBetween(start, end)).toEqual(Result.succeed(expected));
  });

  it.each([
    [
      'a timed event without an end',
      instant('2026-10-28T10:00:00Z'),
      undefined,
      'a timed event needs --end',
    ],
    [
      'an end before the start day',
      date('2026-10-28'),
      date('2026-10-27'),
      '--end is before --start',
    ],
    [
      'an end at the start time',
      instant('2026-10-28T10:00:00Z'),
      instant('2026-10-28T10:00:00Z'),
      '--end must be after --start',
    ],
    [
      'a date with a date-time',
      date('2026-10-28'),
      instant('2026-10-28T10:00:00Z'),
      'must both be dates',
    ],
    [
      'a date-time with a date',
      instant('2026-10-28T10:00:00Z'),
      date('2026-10-29'),
      'must both be dates',
    ],
  ])('refuses %s', (_name, start, end, reason) => {
    expect(failureOf(spanBetween(start, end))).toContain(reason);
  });
});

describe('changedSpan', () => {
  const meeting = times('2026-10-28T10:00:00Z', '2026-10-28T11:30:00Z');
  const trip = days('2026-10-28', '2026-10-30');
  type Change = readonly [
    EventSpan,
    EventTime | undefined,
    EventTime | undefined,
  ];

  it.each<readonly [string, Change, EventSpan]>([
    [
      'moves a timed event and keeps its length',
      [meeting, instant('2026-10-29T08:00:00Z'), undefined],
      times('2026-10-29T08:00:00Z', '2026-10-29T09:30:00Z'),
    ],
    [
      'moves an all-day event and keeps its days',
      [trip, date('2026-11-02'), undefined],
      days('2026-11-02', '2026-11-04'),
    ],
    [
      'changes only the end',
      [meeting, undefined, instant('2026-10-28T12:00:00Z')],
      times('2026-10-28T10:00:00Z', '2026-10-28T12:00:00Z'),
    ],
    [
      'changes only the last day',
      [trip, undefined, date('2026-10-28')],
      days('2026-10-28', '2026-10-28'),
    ],
    [
      'turns a timed event into an all-day one',
      [meeting, date('2026-10-28'), date('2026-10-28')],
      days('2026-10-28', '2026-10-28'),
    ],
    ['keeps the span without a time', [meeting, undefined, undefined], meeting],
  ])('%s', (_name, [current, start, end], expected) => {
    expect(changedSpan(current, start, end)).toEqual(Result.succeed(expected));
  });

  it.each<readonly [string, Change, string]>([
    [
      'a new start of another kind',
      [meeting, date('2026-10-28'), undefined],
      'pass --end as well',
    ],
    [
      'an end of another kind',
      [trip, undefined, instant('2026-10-28T12:00:00Z')],
      'must both be dates',
    ],
    [
      'an end before the start',
      [meeting, undefined, instant('2026-10-28T09:00:00Z')],
      '--end must be after --start',
    ],
  ])('refuses %s', (_name, [current, start, end], reason) => {
    expect(failureOf(changedSpan(current, start, end))).toContain(reason);
  });
});
