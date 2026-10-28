---
name: pim-calendar
description: Read the user's calendars and events over CalDAV, create, change, or delete events, and invite people to meetings, with the pim command. Use when the user asks about their schedule, appointments, or free time, or wants an event added, moved, or removed, or people invited.
---

# pim calendar

Run `pim calendar --help` for the calendar commands and `pim <command> --help` for options. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- `pim calendar events` takes local dates. To answer "am I free on Friday?", pass that date as both `--from` and `--to`.
- A recurring event appears once per occurrence, each with a `recurrenceId`. `pim calendar get` describes the whole series.
- Keep each event's `account` and `href`; `pim calendar get` needs them.
- Read `failures` before saying a day is free: a calendar that failed may hold events.
- Create, change, or delete an event only when the user asked for it. Others may see a shared calendar, so before creating an event, ask which calendar from `pim calendar list` to use if the user did not name one.
- Before `pim calendar update` or `pim calendar delete`, run `pim calendar get` and pass its `etag` exactly, quotes included. If the command reports a conflict, the event changed: get it again and check the change still makes sense.
- Pass `--series` only when the user wants every occurrence of a recurring event renamed, edited, or deleted.
- `--notify-attendees` lets the calendar server email invitations, updates, or cancellations. Pass it only when the user asked to invite, update, or cancel, and after confirming the exact attendee addresses with them. Without it, pim refuses any write that would email someone.
- After inviting, check each attendee's `scheduleStatus`: 1.x means the server sent or delivered the message, 3.x and 5.x mean it did not.
- If an account has no working calendar login, ask the user to run `pim login --account <email> --only dav`.
