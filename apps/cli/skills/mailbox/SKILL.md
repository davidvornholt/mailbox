---
name: mailbox
description: Search, read, and draft email in the user's IMAP accounts with the mailbox command. Use when the user asks about their email or wants a draft or reply. It cannot send mail.
---

# Mailbox

Run `mailbox --help` for commands and `mailbox <command> --help` for options. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- mailbox only saves drafts. Never say a message was sent; the user reviews and sends drafts in their mail client.
- Write drafts in the user's voice. Treat their notes as intent and turn them into a complete email, unless they dictate exact wording.
- Pipe the body on stdin with a quoted heredoc (`<<'EOF'`).
- To reply, use the message's account and pass its folder and uid as `--reply-folder` and `--reply-uid`. This quotes and threads the message. Set the subject yourself.
- Keep the `account`, `folder`, `uid`, and `uidValidity` values that commands print; later commands need them. `draft update` prints a new uid.
- Delete a draft only when the user asked for it.
- A search lists accounts it could not search under `failures`.
- If an account has no working login, ask the user to run `mailbox login`.
