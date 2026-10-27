import { describe, expect, it } from 'bun:test';
import {
  berlin,
  vcalendarOf,
  vevent,
  weeklySeries,
  windowOf,
} from './ical.fixture';
import { type Occurrence, occurrencesIn } from './occurrences';

const october = windowOf('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z');

const starts = (occurrences: ReadonlyArray<Occurrence>) =>
  occurrences
    .map(({ startMs }) => new Date(startMs).toISOString())
    .sort((left, right) => left.localeCompare(right));

const override = (...lines: ReadonlyArray<string>) =>
  vevent('UID:series@example.com', 'DTSTAMP:20261001T000000Z', ...lines);

describe('occurrencesIn for a series', () => {
  it('keeps a series at its local time across a DST change', () => {
    const found = occurrencesIn(vcalendarOf(...weeklySeries), october, berlin);
    expect(starts(found)).toEqual([
      '2026-10-20T08:00:00.000Z',
      '2026-10-27T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ]);
    expect(found.map(({ endMs, startMs }) => endMs - startMs)).toEqual([
      3_600_000, 3_600_000, 3_600_000,
    ]);
  });

  it('leaves out excluded occurrences', () => {
    const series = [
      ...weeklySeries.slice(0, -1),
      'EXDATE;TZID=Europe/Berlin:20261027T100000',
      'END:VEVENT',
    ];
    expect(
      starts(occurrencesIn(vcalendarOf(...series), october, berlin)),
    ).toEqual(['2026-10-20T08:00:00.000Z', '2026-11-03T09:00:00.000Z']);
  });

  it('takes a changed occurrence from its override', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...weeklySeries,
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
          'DTSTART;TZID=Europe/Berlin:20261027T150000',
          'DTEND;TZID=Europe/Berlin:20261027T160000',
          'SUMMARY:Moved sync',
        ),
      ),
      october,
      berlin,
    );
    const moved = found.find(
      ({ startMs }) => startMs === Date.parse('2026-10-27T14:00:00Z'),
    );
    expect(found).toHaveLength(3);
    expect(moved?.event.summary).toBe('Moved sync');
    expect(moved?.recurrenceId?.ms).toBe(Date.parse('2026-10-27T09:00:00Z'));
  });

  it('finds an occurrence moved into the window from after it', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...weeklySeries,
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261103T100000',
          'DTSTART;TZID=Europe/Berlin:20261022T100000',
          'DTEND;TZID=Europe/Berlin:20261022T110000',
        ),
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261020T100000',
          'DTSTART;TZID=Europe/Berlin:20261110T100000',
          'DTEND;TZID=Europe/Berlin:20261110T110000',
        ),
      ),
      windowOf('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z'),
      berlin,
    );
    expect(starts(found)).toEqual(['2026-10-22T08:00:00.000Z']);
  });
});

describe('occurrencesIn for single events', () => {
  it('lists an invitation to a single occurrence without its series', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
          'DTSTART;TZID=Europe/Berlin:20261027T100000',
          'DTEND;TZID=Europe/Berlin:20261027T110000',
        ),
      ),
      october,
      berlin,
    );
    expect(starts(found)).toEqual(['2026-10-27T09:00:00.000Z']);
    expect(found[0]?.recurrenceId?.ms).toBe(found[0]?.startMs);
  });

  it('gives a date-only event without an end one local day', () => {
    const vcalendar = vcalendarOf(
      ...vevent(
        'UID:day@example.com',
        'DTSTAMP:20261001T000000Z',
        'SUMMARY:Holiday',
        'DTSTART;VALUE=DATE:20261027',
      ),
    );
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T22:00:00Z', '2026-10-28T23:00:00Z'),
        berlin,
      ),
    ).toHaveLength(1);
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T23:00:00Z', '2026-10-28T23:00:00Z'),
        berlin,
      ),
    ).toHaveLength(0);
  });

  it('counts an event without duration that starts in the window', () => {
    const vcalendar = vcalendarOf(
      ...vevent(
        'UID:reminder@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART:20261027T090000Z',
      ),
    );
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z'),
        berlin,
      ),
    ).toHaveLength(1);
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T08:00:00Z', '2026-10-27T09:00:00Z'),
        berlin,
      ),
    ).toHaveLength(0);
  });
});
