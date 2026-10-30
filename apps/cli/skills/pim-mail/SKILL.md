---
name: pim-mail
description: Search, read, and draft email in the user's IMAP accounts with the pim command. Use when the user asks about their email or wants a draft or reply. It cannot send mail.
---

# pim mail

Run `pim mail --help` for the mail commands and `pim <command> --help` for their options.

- `pim mail` only saves drafts. Never say a message was sent; the user reviews and sends drafts in their mail client.
- Write drafts in the user's voice. Treat their notes as intent and turn them into a complete email, unless they dictate exact wording.
- Pipe the body on stdin with a quoted heredoc (`<<'EOF'`).
- A message with a `text/calendar` attachment carries calendar data, such as an invitation. Read and answer it with `pim calendar invitation` and `pim calendar respond` from the pim-calendar skill, not with a plain reply. `pim mail draft update` drops the calendar data from an answer draft; run `pim calendar respond` again instead.
- Delete a draft only when the user asked for it.
- Read `failures` before saying nothing was found: an account that failed wasn't searched.
- If an account has no working login, ask the user to run `pim login`.
