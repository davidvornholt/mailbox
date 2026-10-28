import { Effect } from 'effect';
import {
  createContact,
  deleteContact,
  updateContact,
} from '../features/contacts/services/contacts-write';
import type { ContactText } from '../features/contacts/services/vcard-write';
import { AccountConfig } from '../shared/accounts/config';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { type CommandEffect, json } from './command-support';

const accountFlag = flag.text('email', 'Account from "pim contacts books"');

const emailPattern = /^[^\s@]+@[^\s@]+$/u;
const phonePattern = /^[+\d\s()./-]*\d[+\d\s()./-]*$/u;

type ValueKind = { readonly what: string; readonly pattern: RegExp };
const emailKind: ValueKind = {
  what: 'an email address',
  pattern: emailPattern,
};
const phoneKind: ValueKind = {
  what: 'a phone number of digits, spaces, and + ( ) . / -',
  pattern: phonePattern,
};

// The trimmed values, provided each looks like the kind of value the option
// takes.
const checked = (
  command: string,
  option: string,
  values: ReadonlyArray<string>,
  kind: ValueKind,
): Effect.Effect<ReadonlyArray<string>, UsageError> => {
  const trimmed = values.map((value) => value.trim());
  const invalid = trimmed.find((value) => !kind.pattern.test(value));
  return invalid === undefined
    ? Effect.succeed(trimmed)
    : Effect.fail(
        new UsageError({
          message: `pim ${command}: --${option} "${invalid}" is not ${kind.what}`,
        }),
      );
};

type TextValues = Readonly<Record<keyof ContactText, string | undefined>>;

// The text options that were given, trimmed.
const textOf = (values: TextValues): ContactText =>
  Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value.trim()]],
    ),
  );

const create = defineCommand(
  {
    name: 'contacts create',
    summary: 'Create a contact',
    description:
      'Create a contact in one address book. Pass at least one of --name, --given-name, --family-name, or --organization; without --name, the name is built from the others. Repeat --email and --phone for several. Prints the contact with its href and, when the server returns one, its etag.',
    flags: {
      account: accountFlag,
      addressBook: flag.text(
        'name|href',
        'Address book from "pim contacts books"',
      ),
      name: flag.optionalText('text', 'Name to show'),
      givenName: flag.optionalText('text', 'Given name'),
      familyName: flag.optionalText('text', 'Family name'),
      organization: flag.optionalText('text', 'Organization'),
      title: flag.optionalText('text', 'Job title'),
      note: flag.optionalText('text', 'Note'),
      email: flag.texts('address', 'Email address'),
      phone: flag.texts('number', 'Phone number'),
    },
  },
  ({
    account: email,
    addressBook,
    email: emails,
    phone,
    ...texts
  }): CommandEffect =>
    Effect.gen(function* () {
      const command = 'contacts create';
      const text = textOf(texts);
      if (
        [text.name, text.givenName, text.familyName, text.organization].every(
          (value) => value === undefined || value === '',
        )
      ) {
        return yield* new UsageError({
          message: `pim ${command}: pass at least one of --name, --given-name, --family-name, or --organization`,
        });
      }
      const request = {
        ...text,
        addressBook,
        emails: yield* checked(command, 'email', emails, emailKind),
        phones: yield* checked(command, 'phone', phone, phoneKind),
      };
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(email);
      return json(yield* createContact(account, request));
    }),
);

const targetFlags = {
  account: accountFlag,
  href: flag.text('href', 'Contact href from "pim contacts search"'),
  etag: flag.text('etag', 'Etag from "pim contacts get"'),
} as const;

const update = defineCommand(
  {
    name: 'contacts update',
    summary: 'Change a contact',
    description:
      'Change a contact. Pass the etag from "pim contacts get"; if the contact changed since, nothing is written. An empty --given-name, --family-name, --organization, --title, or --note removes it. A name that was built from the given and family name or the organization follows changes to them; --name sets it. Repeat the email and phone options for several values. Phone numbers match by their digits, and removing a value the contact lacks writes nothing. pim does not change contact groups. Prints the changed contact with its new etag, when the server returns one.',
    flags: {
      ...targetFlags,
      name: flag.optionalText('text', 'New name to show'),
      givenName: flag.optionalText('text', 'New given name'),
      familyName: flag.optionalText('text', 'New family name'),
      organization: flag.optionalText('text', 'New organization'),
      title: flag.optionalText('text', 'New job title'),
      note: flag.optionalText('text', 'New note'),
      addEmail: flag.texts('address', 'Email address to add'),
      removeEmail: flag.texts('address', 'Email address to remove'),
      addPhone: flag.texts('number', 'Phone number to add'),
      removePhone: flag.texts('number', 'Phone number to remove'),
    },
  },
  ({
    account: email,
    href,
    etag,
    addEmail,
    removeEmail,
    addPhone,
    removePhone,
    ...texts
  }): CommandEffect =>
    Effect.gen(function* () {
      const command = 'contacts update';
      const text = textOf(texts);
      if (
        Object.keys(text).length === 0 &&
        [addEmail, removeEmail, addPhone, removePhone].every(
          (values) => values.length === 0,
        )
      ) {
        return yield* new UsageError({
          message: `pim ${command}: pass at least one change`,
        });
      }
      if (text.name === '') {
        return yield* new UsageError({
          message: `pim ${command}: --name is empty`,
        });
      }
      const changes = {
        ...text,
        addEmails: yield* checked(command, 'add-email', addEmail, emailKind),
        removeEmails: yield* checked(
          command,
          'remove-email',
          removeEmail,
          emailKind,
        ),
        addPhones: yield* checked(command, 'add-phone', addPhone, phoneKind),
        removePhones: yield* checked(
          command,
          'remove-phone',
          removePhone,
          phoneKind,
        ),
      };
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(email);
      return json(yield* updateContact(account, { href, etag }, changes));
    }),
);

const remove = defineCommand(
  {
    name: 'contacts delete',
    summary: 'Delete a contact',
    description:
      'Delete a contact. Pass the etag from "pim contacts get"; if the contact changed since, nothing is deleted. pim does not delete contact groups. Prints the deleted contact.',
    flags: targetFlags,
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const deleted = yield* deleteContact(account, {
        href: values.href,
        etag: values.etag,
      });
      return json({ deleted });
    }),
);

export const contactWriteCommands = [create, update, remove];
