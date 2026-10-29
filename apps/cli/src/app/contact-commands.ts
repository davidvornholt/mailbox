import { Effect } from 'effect';
import {
  accountAddressBooks,
  accountContact,
  accountContacts,
} from '../features/contacts/services/contacts';
import { acrossAccounts } from '../shared/accounts/across';
import { AccountConfig } from '../shared/accounts/config';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { davAccounts } from '../shared/dav/accounts';
import { type CommandEffect, json } from './command-support';

const defaultContactLimit = 50;

const books = defineCommand(
  {
    name: 'contacts books',
    summary: 'List address books',
    description:
      'List the address books of every account with [accounts.dav], or of one account. Accounts that fail are listed under "failures".',
    flags: {
      account: flag.optionalText('email', 'List only this account'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const accounts = yield* davAccounts(values.account);
      const { results, failures } = yield* acrossAccounts(
        accounts,
        accountAddressBooks,
      );
      return json({ addressBooks: results.flat(), failures });
    }),
);

const search = defineCommand(
  {
    name: 'contacts search',
    summary: 'Search contacts',
    description:
      'Search contacts by name, organization, email, or phone number, sorted by name. Without --query, list every contact. Accounts that fail, and contacts that cannot be read, are listed under "failures".',
    flags: {
      account: flag.optionalText('email', 'Search only this account'),
      addressBook: flag.optionalText(
        'name|href',
        'Search only this address book of --account',
      ),
      query: flag.optionalText(
        'text',
        'Match the name, organization, emails, and phone numbers',
      ),
      limit: flag.optionalInteger(
        'n',
        `Maximum contacts (default ${defaultContactLimit})`,
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      if (values.addressBook !== undefined && values.account === undefined) {
        return yield* new UsageError({
          message: 'pim contacts search: --address-book needs --account',
        });
      }
      const limit = values.limit ?? defaultContactLimit;
      if (limit < 1) {
        return yield* new UsageError({
          message: 'pim contacts search: --limit must be at least 1',
        });
      }
      const accounts = yield* davAccounts(values.account);
      const { results, failures } = yield* acrossAccounts(accounts, (account) =>
        accountContacts(account, {
          ...(values.addressBook === undefined
            ? {}
            : { addressBook: values.addressBook }),
          ...(values.query === undefined ? {} : { text: values.query }),
        }),
      );
      const found = results
        .flatMap((result) => result.contacts)
        .sort((left, right) => left.name.localeCompare(right.name));
      return json({
        contacts: found.slice(0, limit),
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
    name: 'contacts get',
    summary: 'Show one contact',
    description:
      'Show every detail of a contact. The etag identifies this version of the contact.',
    flags: {
      account: flag.text('email', 'Account from "pim contacts search"'),
      href: flag.text('href', 'Contact href from "pim contacts search"'),
      raw: flag.switch('Include the vCard text as "vcard"'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const config = yield* AccountConfig;
      const account = yield* config.getAccount(values.account);
      const { vcard, ...detail } = yield* accountContact(account, values.href);
      return json(values.raw ? { ...detail, vcard } : detail);
    }),
);

export const contactCommands = [books, search, get];
