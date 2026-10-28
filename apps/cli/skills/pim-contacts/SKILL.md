---
name: pim-contacts
description: Look up people in the user's address books over CardDAV, and create, change, or delete contacts, with the pim command. Use when the user asks for someone's email address, phone number, or other contact details, or wants a contact added, changed, or removed.
---

# pim contacts

Run `pim contacts --help` for the contacts commands and `pim <command> --help` for options. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- When several contacts match, ask the user which one they mean instead of choosing.
- Keep a contact's `account` and `href`; `pim contacts get` needs them for addresses, birthdays, and notes.
- Create, change, or delete a contact only when the user asked for it. Others may see a shared address book, so before creating a contact, ask which address book from `pim contacts books` to use if the user did not name one.
- Before `pim contacts update` or `pim contacts delete`, run `pim contacts get` and pass its `etag` exactly, quotes included. If the command reports a conflict, the contact changed: get it again and check the change still makes sense.
- If an account has no working contacts login, ask the user to run `pim login --account <email> --only dav`.
