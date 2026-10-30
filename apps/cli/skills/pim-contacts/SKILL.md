---
name: pim-contacts
description: Look up and change contacts in the user's address books with the pim command. Use when the user asks for someone's email address, phone number, or other contact details, or wants a contact added, changed, or removed.
---

# pim contacts

Run `pim contacts --help` for the contacts commands and `pim <command> --help` for their options.

- When several contacts match, ask the user which one they mean instead of choosing.
- Search results leave out addresses, birthdays, and notes; `pim contacts get` shows them.
- Create, change, or delete a contact only when the user asked for it. Others may see a shared address book, so before creating a contact, ask which address book from `pim contacts books` to use if the user did not name one.
- Pass the `etag` from `pim contacts get` exactly, quotes included. If a write reports a conflict, the contact changed: get it again and check the change still makes sense.
