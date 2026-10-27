import { DateTime } from 'effect';

const yearDigits = 4;
const dayMs = 86_400_000;

export type CalendarDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

const fromUtc = (date: Date): CalendarDate => ({
  year: date.getUTCFullYear(),
  month: date.getUTCMonth() + 1,
  day: date.getUTCDate(),
});

export const formatCalendarDate = ({
  year,
  month,
  day,
}: CalendarDate): string =>
  `${String(year).padStart(yearDigits, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// Accepts only real dates in the form YYYY-MM-DD.
export const parseCalendarDate = (value: string): CalendarDate | undefined => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? undefined
    : fromUtc(date);
};

export const addDays = (date: CalendarDate, days: number): CalendarDate =>
  fromUtc(new Date(Date.UTC(date.year, date.month - 1, date.day + days)));

export const daysBetween = (from: CalendarDate, to: CalendarDate): number =>
  (Date.UTC(to.year, to.month - 1, to.day) -
    Date.UTC(from.year, from.month - 1, from.day)) /
  dayMs;

export const today = (local: DateTime.TimeZone): CalendarDate => {
  const parts = DateTime.toParts(DateTime.setZone(DateTime.nowUnsafe(), local));
  return { year: parts.year, month: parts.month, day: parts.day };
};
