---
name: pim-calendar
description: Read the user's calendars and events over CalDAV with the pim command. Use when the user asks about their schedule, appointments, or free time.
---

# pim calendar

Run `pim calendar --help` for the calendar commands and `pim <command> --help` for options. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- The calendar commands only read. Do not tell the user that you created, changed, or answered an event.
- `pim calendar events` takes local dates. To answer "am I free on Friday?", pass that date as both `--from` and `--to`.
- Times are in the user's local zone with their offset. An all-day event gives dates, and its `end` is its last day.
- A recurring event appears once per occurrence, each with a `recurrenceId`. `pim calendar get` describes the whole series.
- Keep each event's `account` and `href`; `pim calendar get` needs them.
- Read `failures` before saying a day is free: a calendar that failed may hold events.
- If an account has no working calendar login, ask the user to run `pim login --account <email> --only dav`.
