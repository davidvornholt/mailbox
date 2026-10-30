import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { fakeGraph } from '../../../shared/graph/graph-server.fixture';
import type { GraphEvent } from './graph-events';
import { berlin } from './ical.fixture';
import { graphReminder, graphReminders } from './outlook-reminders';
import { createOutlookEvent, updateOutlookEvent } from './outlook-write';
import type { ReminderTime } from './reminders';

const relative = (
  minutes: number,
  related: 'start' | 'end' = 'start',
): ReminderTime => ({
  _tag: 'Relative',
  days: 0,
  seconds: minutes * 60,
  related,
});

const reminderOf = (reminders?: ReadonlyArray<ReminderTime>) =>
  Effect.runSync(
    Effect.result(
      graphReminder('event-1', {
        ...(reminders === undefined ? {} : { reminders }),
        zone: berlin,
      }),
    ),
  );

const refusal = (unkept: string) => ({
  _tag: 'Failure',
  failure: {
    _tag: 'EventChangeError',
    href: 'event-1',
    message: `Outlook keeps one reminder per event, a whole number of minutes before the start, like --reminder 15m, so pim cannot set ${unkept}`,
  },
});

describe('graphReminder', () => {
  it.each([
    ['no reminders', undefined, {}],
    ['an empty list', [], { isReminderOn: false }],
    [
      '15m',
      [relative(-15)],
      { isReminderOn: true, reminderMinutesBeforeStart: 15 },
    ],
    [
      '0m',
      [relative(0)],
      { isReminderOn: true, reminderMinutesBeforeStart: 0 },
    ],
    [
      '1d',
      [{ _tag: 'Relative', days: -1, seconds: 0, related: 'start' } as const],
      { isReminderOn: true, reminderMinutesBeforeStart: 1440 },
    ],
  ])('maps %s', (_, reminders, expected) => {
    expect(reminderOf(reminders)).toMatchObject({
      _tag: 'Success',
      success: expected,
    });
  });

  it.each([
    ['2 reminders', [relative(-15), relative(-60)]],
    ['a reminder 10m after start', [relative(10)]],
    ['a reminder 1h before end', [relative(-60, 'end')]],
    [
      'a reminder at 2026-11-10T18:00:00+01:00',
      [{ _tag: 'Absolute', ms: Date.parse('2026-11-10T17:00:00Z') } as const],
    ],
  ])('refuses %s', (unkept, reminders) => {
    expect(reminderOf(reminders)).toMatchObject(refusal(unkept));
  });
});

describe('graphReminders', () => {
  const event = (fields: Partial<GraphEvent>): GraphEvent => ({
    id: 'event-1',
    start: { dateTime: '2026-11-17T13:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-17T14:00:00.0000000', timeZone: 'UTC' },
    ...fields,
  });

  it.each([
    [
      'a reminder in the form --reminder takes',
      { isReminderOn: true, reminderMinutesBeforeStart: 90 },
      [{ when: '1h30m before start' }],
    ],
    [
      'a reminder a day before in hours, as Outlook counts exact minutes',
      { isReminderOn: true, reminderMinutesBeforeStart: 1440 },
      [{ when: '24h before start' }],
    ],
    [
      'a reminder at the start',
      { isReminderOn: true, reminderMinutesBeforeStart: 0 },
      [{ when: '0m before start' }],
    ],
    [
      'no reminder when it is off',
      { isReminderOn: false, reminderMinutesBeforeStart: 15 },
      [],
    ],
    [
      'no reminder without its minutes',
      { isReminderOn: true, reminderMinutesBeforeStart: null },
      [],
    ],
  ])('reads %s', (_, fields, expected) => {
    expect(graphReminders(event(fields))).toEqual(expected);
  });
});

const stored = {
  '@odata.etag': 'W/"1"',
  id: 'event-1',
  subject: 'Planning',
  start: { dateTime: '2026-11-17T13:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-17T14:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false,
  type: 'singleInstance',
  isOrganizer: true,
  attendees: [],
};

const target = {
  href: 'event-1',
  etag: 'W/"1"',
  series: false,
  notifyAttendees: false,
};

describe('Outlook writes with reminders', () => {
  it('sets the reminder of a new event', async () => {
    const { client, requests } = fakeGraph({
      'POST /me/calendars/cal-1/events': stored,
      '/me/events/event-1': stored,
    });
    await Effect.runPromise(
      createOutlookEvent(
        client,
        { id: 'cal-1', canEdit: true },
        {
          title: 'Planning',
          span: {
            _tag: 'Times',
            startMs: Date.parse('2026-11-17T13:00:00Z'),
            endMs: Date.parse('2026-11-17T14:00:00Z'),
          },
          reminders: [relative(-15)],
          attendees: [],
          notifyAttendees: false,
          zone: berlin,
          teams: false,
        },
        berlin,
      ),
    );
    expect(requests[0]?.body).toMatchObject({
      isReminderOn: true,
      reminderMinutesBeforeStart: 15,
    });
  });

  it('turns the reminder of an event off', async () => {
    const { client, requests } = fakeGraph({
      '/me/events/event-1': stored,
      'PATCH /me/events/event-1': stored,
    });
    await Effect.runPromise(
      updateOutlookEvent(
        client,
        target,
        { reminders: [], zone: berlin, teams: false },
        berlin,
      ),
    );
    expect(requests.find(({ method }) => method === 'PATCH')?.body).toEqual({
      isReminderOn: false,
    });
  });

  it('asks Microsoft Graph nothing for a reminder Outlook cannot keep', async () => {
    const { client, requests } = fakeGraph({});
    const error = await Effect.runPromise(
      Effect.flip(
        updateOutlookEvent(
          client,
          target,
          { reminders: [relative(-10, 'end')], zone: berlin, teams: false },
          berlin,
        ),
      ),
    );
    expect(error._tag).toBe('EventChangeError');
    expect(requests).toEqual([]);
  });
});
