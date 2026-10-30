import { describe, expect, it } from 'bun:test';
import { DateTime, Effect, Result } from 'effect';
import ICAL from 'ical.js';
import {
  cancelledDays,
  type GraphSeries,
  graphEventDetail,
  recurrenceRule,
  seriesRecurrence,
} from './graph-detail';
import { type GraphEvent, graphSpan } from './graph-events';

// Central European Time, UTC+1, in November 2026.
const berlin = DateTime.zoneMakeNamedUnsafe('Europe/Berlin');

const utc = (time: string) => ({ dateTime: time, timeZone: 'UTC' });

const rule = (
  pattern: Record<string, unknown>,
  range: Record<string, unknown> = { type: 'noEnd' },
  first: Parameters<typeof recurrenceRule>[1] = {
    allDay: true,
    startMs: Date.parse('2026-11-03T00:00:00Z'),
  },
) =>
  recurrenceRule(
    {
      pattern: { interval: 1, ...pattern },
      range,
    } as Parameters<typeof recurrenceRule>[0],
    first,
  );

// The starts of the occurrences an iCalendar rule gives from start.
const expand = (recur: string, start: string): ReadonlyArray<string> => {
  const iterator = ICAL.Recur.fromString(recur).iterator(
    ICAL.Time.fromDateTimeString(start),
  );
  const starts: Array<string> = [];
  for (let next = iterator.next(); next !== null; next = iterator.next()) {
    starts.push(next.toString());
  }
  return starts;
};

describe('recurrenceRule', () => {
  it('maps daily and weekly patterns', () => {
    expect(rule({ type: 'daily' })).toBe('FREQ=DAILY');
    expect(
      rule({
        type: 'weekly',
        daysOfWeek: ['monday', 'wednesday'],
        firstDayOfWeek: 'sunday',
      }),
    ).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(
      rule(
        {
          type: 'weekly',
          interval: 2,
          daysOfWeek: ['friday'],
          firstDayOfWeek: 'sunday',
        },
        { type: 'endDate', startDate: '2026-11-06', endDate: '2026-12-31' },
      ),
    ).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;WKST=SU;UNTIL=20261231');
  });

  it('ends a timed series after the occurrence on its last day', () => {
    const daily = rule(
      { type: 'daily' },
      { type: 'endDate', startDate: '2026-11-03', endDate: '2026-11-05' },
      { allDay: false, startMs: Date.parse('2026-11-03T13:00:00Z') },
    );
    expect(daily).toBe('FREQ=DAILY;UNTIL=20261106T010000Z');
    expect(expand(daily ?? '', '2026-11-03T13:00:00Z')).toEqual([
      '2026-11-03T13:00:00Z',
      '2026-11-04T13:00:00Z',
      '2026-11-05T13:00:00Z',
    ]);
  });

  it('maps monthly patterns', () => {
    expect(
      rule(
        { type: 'absoluteMonthly', dayOfMonth: 15 },
        { type: 'numbered', numberOfOccurrences: 10 },
      ),
    ).toBe('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=10');
    expect(
      rule({
        type: 'relativeMonthly',
        daysOfWeek: ['thursday'],
        index: 'last',
      }),
    ).toBe('FREQ=MONTHLY;BYDAY=TH;BYSETPOS=-1');
    expect(rule({ type: 'relativeMonthly', daysOfWeek: ['monday'] })).toBe(
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
    );
  });

  it('maps yearly patterns', () => {
    expect(rule({ type: 'absoluteYearly', month: 3, dayOfMonth: 1 })).toBe(
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1',
    );
    expect(
      rule({
        type: 'relativeYearly',
        month: 11,
        daysOfWeek: ['thursday'],
        index: 'fourth',
      }),
    ).toBe('FREQ=YEARLY;BYMONTH=11;BYDAY=TH;BYSETPOS=4');
  });

  it('gives no rule for a pattern pim does not know', () => {
    expect(rule({ type: 'lunar' })).toBeUndefined();
  });
});

describe('cancelledDays', () => {
  it('reads the day from each cancelled occurrence id', () => {
    expect(
      cancelledDays([
        'OID.series-1.2026-11-10',
        'OID.series-1.2026-11-24',
        'other',
      ]),
    ).toEqual(['2026-11-10', '2026-11-24']);
  });
});

const weekly = {
  pattern: { type: 'weekly', interval: 1, daysOfWeek: ['tuesday'] },
  range: { type: 'noEnd' },
};

const attendee = (address: string, response: string) => ({
  type: 'required',
  status: { response },
  emailAddress: { name: null, address },
});

const series: GraphSeries = {
  id: 'series-1',
  start: utc('2026-11-03T13:00:00.0000000'),
  end: utc('2026-11-03T14:00:00.0000000'),
  isAllDay: false,
  subject: 'Planning',
  location: { displayName: 'Room 4' },
  attendees: [attendee('bo@example.com', 'accepted')],
  recurrence: weekly,
  cancelledOccurrences: ['OID.series-1.2026-11-10'],
};

const exception = (fields: Partial<GraphEvent>): GraphEvent => ({
  id: 'event-x',
  type: 'exception',
  subject: 'Planning',
  location: { displayName: 'Room 4' },
  attendees: [attendee('bo@example.com', 'accepted')],
  start: utc('2026-11-17T13:00:00.0000000'),
  end: utc('2026-11-17T14:00:00.0000000'),
  originalStart: '2026-11-17T13:00:00Z',
  ...fields,
});

const recurrenceOf = (master: GraphSeries) =>
  Effect.runPromise(Effect.result(seriesRecurrence(master, berlin)));

describe('seriesRecurrence', () => {
  it('gives the rule, the skipped days, and the occurrences that differ', async () => {
    expect(
      await recurrenceOf({
        ...series,
        exceptionOccurrences: [
          exception({
            id: 'event-y',
            subject: 'Planning with guests',
            attendees: [attendee('bo@example.com', 'declined')],
            start: utc('2026-11-24T13:00:00.0000000'),
            end: utc('2026-11-24T14:00:00.0000000'),
            originalStart: '2026-11-24T13:00:00Z',
          }),
          exception({
            start: utc('2026-11-17T15:00:00.0000000'),
            end: utc('2026-11-17T16:00:00.0000000'),
          }),
        ],
      }),
    ).toEqual(
      Result.succeed({
        rule: 'FREQ=WEEKLY;BYDAY=TU',
        excluded: ['2026-11-10'],
        changed: [
          {
            recurrenceId: '2026-11-17T14:00:00+01:00',
            start: '2026-11-17T16:00:00+01:00',
            end: '2026-11-17T17:00:00+01:00',
          },
          {
            recurrenceId: '2026-11-24T14:00:00+01:00',
            start: '2026-11-24T14:00:00+01:00',
            end: '2026-11-24T15:00:00+01:00',
            summary: 'Planning with guests',
            attendees: [
              {
                email: 'bo@example.com',
                role: 'req-participant',
                partstat: 'declined',
              },
            ],
          },
        ],
      }),
    );
  });

  it('gives an event without recurrence none', async () => {
    const { recurrence: _recurrence, ...single } = series;
    expect(await recurrenceOf(single)).toMatchObject({ success: undefined });
  });

  it('fails on a changed occurrence it cannot read', async () => {
    expect(
      await recurrenceOf({
        ...series,
        exceptionOccurrences: [{ id: 'event-z' }],
      }),
    ).toMatchObject({
      failure: { _tag: 'CalendarDataError', href: 'event-z' },
    });
  });
});

describe('graphEventDetail', () => {
  const event: GraphEvent = {
    id: 'event-1',
    iCalUId: 'uid-1',
    subject: 'Planning',
    start: utc('2026-11-03T13:00:00.0000000'),
    end: utc('2026-11-03T14:00:00.0000000'),
    isAllDay: false,
    organizer: { emailAddress: { name: 'Ana', address: 'ana@example.com' } },
    attendees: [attendee('ana@example.com', 'organizer')],
    body: { contentType: 'text', content: 'Agenda:\nbudget' },
    webLink: 'https://outlook.example.com/event-1',
  };

  const detailOf = async (shown: GraphEvent) =>
    graphEventDetail(shown, await Effect.runPromise(graphSpan(shown, berlin)), {
      account: 'me@example.com',
      recurrence: undefined,
    });

  it('describes the event without etag or iCalendar text', async () => {
    expect(await detailOf(event)).toEqual({
      account: 'me@example.com',
      href: 'event-1',
      uid: 'uid-1',
      summary: 'Planning',
      start: '2026-11-03T14:00:00+01:00',
      end: '2026-11-03T15:00:00+01:00',
      allDay: false,
      description: 'Agenda:\nbudget',
      url: 'https://outlook.example.com/event-1',
      organizer: { email: 'ana@example.com', name: 'Ana' },
      attendees: [
        { email: 'ana@example.com', role: 'chair', partstat: 'accepted' },
      ],
      reminders: [],
    });
  });

  it('turns an HTML description into text', async () => {
    const detail = await detailOf({
      ...event,
      body: {
        contentType: 'html',
        content:
          '<html><body><p>Agenda:</p><p>budget <img src="x.png"></p></body></html>',
      },
    });
    expect(detail.description).toBe('Agenda:\n\nbudget');
  });
});
