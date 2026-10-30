import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import { berlin } from './ical.fixture';
import {
  parseReminder,
  type ReminderTime,
  reminderFormats,
  reminderWhen,
} from './reminders';

const relative = (
  minutes: number,
  related: 'start' | 'end' = 'start',
): ReminderTime => ({ _tag: 'Relative', minutes, related });

const absolute = (iso: string): ReminderTime => ({
  _tag: 'Absolute',
  ms: Date.parse(iso),
});

describe('parseReminder', () => {
  it.each([
    ['15m', relative(-15)],
    ['1h30m', relative(-90)],
    ['1d', relative(-1440)],
    ['2w', relative(-20_160)],
    ['1w2d3h4m', relative(-13_144)],
    ['0m', relative(0)],
    ['10m after start', relative(10)],
    ['1h before end', relative(-60, 'end')],
    ['5m  after   end', relative(5, 'end')],
    ['2026-11-10T18:00', absolute('2026-11-10T17:00:00Z')],
    ['2026-11-10T18:00:00+05:00', absolute('2026-11-10T13:00:00Z')],
    ['2026-11-10T18:00Z', absolute('2026-11-10T18:00:00Z')],
  ])('reads %p', (value, expected) => {
    expect(parseReminder(value, berlin)).toEqual(Result.succeed(expected));
  });

  it.each([
    ['soon', `must be ${reminderFormats}`],
    ['15', `must be ${reminderFormats}`],
    ['15 m', `must be ${reminderFormats}`],
    ['-15m', `must be ${reminderFormats}`],
    ['30m1h', `must be ${reminderFormats}`],
    ['15m before', `must be ${reminderFormats}`],
    ['15m before middle', `must be ${reminderFormats}`],
    ['2026-11-10', `must be ${reminderFormats}`],
    ['2026-02-30T10:00', 'is not a real date and time'],
    [
      '2026-03-29T02:30',
      'does not exist or occurs twice in Europe/Berlin because of a daylight saving change; add the UTC offset, like +01:00',
    ],
  ])('refuses %p', (value, reason) => {
    expect(parseReminder(value, berlin)).toEqual(Result.fail(reason));
  });
});

describe('reminderWhen', () => {
  it.each([
    ['1440m', '1d before start'],
    ['90m', '1h30m before start'],
    ['7d', '1w before start'],
    ['8d', '1w1d before start'],
    ['0m', '0m before start'],
    ['0m after end', '0m before end'],
    ['120m after start', '2h after start'],
    ['25h before end', '1d1h before end'],
    ['2026-11-10T18:00', '2026-11-10T18:00:00+01:00'],
    ['2026-07-01T09:30Z', '2026-07-01T11:30:00+02:00'],
  ])('prints %p as %p, which reads back the same', (value, printed) => {
    const time = Result.getOrThrow(parseReminder(value, berlin));
    expect(reminderWhen(time, berlin)).toBe(printed);
    expect(parseReminder(printed, berlin)).toEqual(Result.succeed(time));
  });
});
