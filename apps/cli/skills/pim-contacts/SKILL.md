---
name: pim-contacts
description: Look up people in the user's address books over CardDAV with the pim command. Use when the user asks for someone's email address, phone number, or other contact details.
---

# pim contacts

Run `pim contacts --help` for the contacts commands and `pim <command> --help` for options. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- The contacts commands only read. Do not tell the user that you added or changed a contact.
- When several contacts match, ask the user which one they mean instead of choosing.
- Keep a contact's `account` and `href`; `pim contacts get` needs them for addresses, birthdays, and notes.
- If an account has no working contacts login, ask the user to run `pim login --account <email> --only dav`.
