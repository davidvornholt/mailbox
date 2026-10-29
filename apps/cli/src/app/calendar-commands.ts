import { DateTime, Effect } from 'effect';
import {
  accountCalendars,
  accountEvent,
  accountEvents,
  byStart,
  calendarAccounts,
} from '../features/calendar/services/calendar';
import {
  addDays,
  type CalendarDate,
  daysBetween,
  formatCalendarDate,
  parseCalendarDate,
  today,
} from '../features/calendar/services/calendar-dates';
import { localDayWindow } from '../features/calendar/services/ical-time';
import { acrossAccounts } from '../shared/accounts/across';
import { AccountConfig } from '../shared/accounts/config';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { type CommandEffect, json } from './command-support';

const defaultEventDays = 7;
const defaultEventLimit = 100;

const dateFlag = (
  name: string,
  value: string | undefined,
  fallback: CalendarDate,
): Effect.Effect<CalendarDate, UsageError> => {
  if (value === undefined) {
    return Effect.succeed(fallback);
  }
  const date = parseCalendarDate(value);
  return date === undefined
    ? Effect.fail(
        new UsageError({
          message: `pim calendar events: --${name} must be a date like 2026-10-27, not "${value}"`,
        }),
      )
    : Effect.succeed(date);
};

const list = defineCommand(
  {
    name: 'calendar list',
    summary: 'List calendars',
    description:
      'List the calendars of every account with a dav or graph table, or of one account. Outlook calendars from a graph table include those shared with the user, and pim only reads them. Accounts that fail are listed under "failures".',
    flags: {
      account: flag.optionalText('email', 'List only this account'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const accounts = yield* calendarAccounts(values.account);
      const { results, failures } = yield* acrossAccounts(
        accounts,
        accountCalendars,
      );
      return json({ calendars: results.flat(), failures });
    }),
);

const events = defineCommand(
  {
    name: 'calendar events',
    summary: 'List events in a date range',
    description: `List events from the start of --from to the end of --to, in start order, with each occurrence of a recurring event. Times are local date-times with offset; all-day events give dates, and their end is the last day. Without --from, the range starts today and lasts ${defaultEventDays} days. Accounts that fail, and events that cannot be read, are listed under "failures".`,
    flags: {
      account: flag.optionalText('email', 'List only this account'),
      calendar: flag.optionalText(
        'name|href',
        'List only this calendar of --account',
      ),
      from: flag.optionalText('YYYY-MM-DD', 'First day (default today)'),
      to: flag.optionalText(
        'YYYY-MM-DD',
        `Last day (default ${defaultEventDays - 1} days after --from)`,
      ),
      query: flag.optionalText(
        'text',
        'Match the title, location, and description (for Outlook, the start of the description)',
      ),
      limit: flag.optionalInteger(
        'n',
        `Maximum events (default ${defaultEventLimit})`,
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      if (values.calendar !== undefined && values.account === undefined) {
        return yield* new UsageError({
          message: 'pim calendar events: --calendar needs --account',
        });
      }
      const limit = values.limit ?? defaultEventLimit;
      if (limit < 1) {
        return yield* new UsageError({
          message: 'pim calendar events: --limit must be at least 1',
        });
      }
      const local = DateTime.zoneMakeLocal();
      const from = yield* dateFlag('from', values.from, today(local));
      const to = yield* dateFlag(
        'to',
        values.to,
        addDays(from, defaultEventDays - 1),
      );
      if (daysBetween(from, to) < 0) {
        return yield* new UsageError({
          message: 'pim calendar events: --to is before --from',
        });
      }
      const accounts = yield* calendarAccounts(values.account);
      const { results, failures } = yield* acrossAccounts(accounts, (account) =>
        accountEvents(
          account,
          {
            window: localDayWindow(from, to, local),
            ...(values.calendar === undefined
              ? {}
              : { calendar: values.calendar }),
            ...(values.query === undefined ? {} : { text: values.query }),
          },
          local,
        ),
      );
      const found = results.flatMap((result) => result.events).sort(byStart);
      return json({
        from: formatCalendarDate(from),
        to: formatCalendarDate(to),
        events: found.slice(0, limit).map(({ event }) => event),
        ...(found.length > limit ? { truncated: true } : {}),
        failures: [
          ...failures,
          ...results.flatMap((result) => result.unreadable),
        ],
      });
    }),
);

const get = defineCommand(
  {
    name: 'calendar get',
    summary: 'Show one event',
    description:
      'Show an event with its description, organizer, attendees, and, for a recurring event, its rule and the occurrences that differ from it. The etag identifies this version of a CalDAV event. An Outlook event is the occurrence its href names, with the rule of its series.',
    flags: {
      account: flag.text('email', 'Account from "pim calendar events"'),
      href: flag.text('href', 'Event href from "pim calendar events"'),
      raw: flag.switch(
        'Include the iCalendar text as "ics" (CalDAV events only)',
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const { ics, ...detail } = yield* accountEvent(
        account,
        values.href,
        DateTime.zoneMakeLocal(),
      );
      return json(
        values.raw && ics !== undefined ? { ...detail, ics } : detail,
      );
    }),
);

export const calendarCommands = [list, events, get];
