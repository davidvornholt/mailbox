---
name: pim-calendar
description: Read and change the user's calendars, including Outlook, with the pim command. Use for their schedule and free time, events, Teams and other meetings, inviting people, and answering invitations.
---

# pim calendar

Run `pim calendar --help` for the calendar commands and `pim <command> --help` for their options.

- Read `failures` before saying a day is free: a calendar that failed may hold events.
- Write to a calendar or answer an invitation only when the user asked for it, and add a Teams meeting only when they asked for one. Others may see a shared calendar, so ask which calendar from `pim calendar list` to put a new event in if the user did not name one.
- Pass the `etag` from `pim calendar get` exactly, quotes included. If a write reports a conflict, the event changed: get it again and check the change still makes sense.
- Pass `--series` only when the user wants every occurrence of a recurring event changed, deleted, or answered.
- Before passing `--notify-attendees`, confirm the exact attendee addresses with the user, including those an occurrence lists under `recurrence.changed`.
- After a write that makes the server email someone, read the `scheduleStatus` values it prints: 1.0 means pending, 1.1 sent, 1.2 delivered, and 3.x or 5.x that the server did not send it. Without a status, delivery is unknown; do not repeat the write.
- An invitation the user received is an email with a `text/calendar` attachment. Find it with `pim mail search` and pass its account, folder, and uid to `pim calendar invitation`, `import`, or `respond`. When `respond` prints `"reply": "draft"`, tell the user the answer is a draft they must send themselves.
