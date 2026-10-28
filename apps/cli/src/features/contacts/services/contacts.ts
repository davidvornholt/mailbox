import { Effect, Result } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import type { AccountFailure } from '../../../shared/dav/accounts';
import {
  describeCollections,
  findCollection,
} from '../../../shared/dav/collections';
import { Dav, type DavSessionError } from '../../../shared/dav/dav';
import type { DavRequestError } from '../../../shared/errors/dav';
import { AddressBookNotFoundError, ContactDataError } from '../errors/errors';
import type {
  AddressBook,
  ContactDetail,
  ContactSummary,
} from '../schemas/contacts';
import {
  type ContactResource,
  fetchContact,
  listAddressBooks,
  queryContacts,
} from './carddav';
import {
  contactDetail,
  displayName,
  emailsOf,
  organizationOf,
  parseVCard,
  phonesOf,
} from './vcard';

const addressBookConcurrency = 4;
// A query with this many digits is also compared with phone numbers.
const minPhoneDigits = 3;

export type ContactsError = DavSessionError | DavRequestError;

export const accountAddressBooks = (
  account: Account,
): Effect.Effect<ReadonlyArray<AddressBook>, ContactsError, Dav> =>
  Dav.pipe(
    Effect.flatMap((dav) => dav.client(account)),
    Effect.flatMap(listAddressBooks),
  );

export const findAddressBook = (
  account: string,
  books: ReadonlyArray<AddressBook>,
  wanted: string,
): Effect.Effect<AddressBook, AddressBookNotFoundError> =>
  Result.match(findCollection(books, wanted), {
    onSuccess: Effect.succeed,
    onFailure: (reason) =>
      Effect.fail(
        new AddressBookNotFoundError({
          addressBook: wanted,
          message:
            reason === 'ambiguous'
              ? `${account} has several address books that match "${wanted}"; pass an exact href from "pim contacts books" instead`
              : `${account} has no address book "${wanted}". Its address books: ${describeCollections(books)}`,
        }),
      ),
  });

const digits = (value: string): string => value.replace(/\D/gu, '');

export const matchesContact = (
  contact: ContactSummary,
  query: string,
): boolean => {
  const text = query.trim().toLowerCase();
  const queryDigits = digits(query);
  return (
    [contact.name, contact.organization ?? '', ...contact.emails].some(
      (value) => value.toLowerCase().includes(text),
    ) ||
    (queryDigits.length >= minPhoneDigits &&
      contact.phones.some((phone) => digits(phone).includes(queryDigits)))
  );
};

// ical.js decodes a value only when it is read, so a malformed field, such as
// TEL;VALUE=utc-offset:garbage, throws here rather than in parseVCard.
export const readContact = <A>(
  href: string,
  read: () => A,
): Effect.Effect<A, ContactDataError> =>
  Effect.try({
    try: read,
    catch: (cause) =>
      new ContactDataError({
        href,
        message: `Could not read ${href}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const contactSummary = (
  account: string,
  addressBook: string,
  resource: Result.Result<ContactResource, ContactDataError>,
): Effect.Effect<ContactSummary, ContactDataError> =>
  Effect.fromResult(resource).pipe(
    Effect.flatMap(({ href, vcard }) =>
      parseVCard(href, vcard).pipe(
        Effect.flatMap((card) =>
          readContact(href, (): ContactSummary => {
            const organization = organizationOf(card);
            return {
              account,
              addressBook,
              href,
              name: displayName(card),
              ...(organization === undefined ? {} : { organization }),
              emails: emailsOf(card),
              phones: phonesOf(card),
            };
          }),
        ),
      ),
    ),
  );

// Contacts of one account, and the vCards it could not read.
export type AccountContacts = {
  readonly contacts: ReadonlyArray<ContactSummary>;
  readonly unreadable: ReadonlyArray<AccountFailure>;
};

export const accountContacts = (
  account: Account,
  query: { readonly addressBook?: string; readonly text?: string },
): Effect.Effect<
  AccountContacts,
  ContactsError | AddressBookNotFoundError,
  Dav
> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const books = yield* listAddressBooks(client);
    const selected =
      query.addressBook === undefined
        ? books
        : [yield* findAddressBook(account.email, books, query.addressBook)];
    const perBook = yield* Effect.forEach(
      selected,
      (book) =>
        queryContacts(client, book.href).pipe(
          Effect.map((resources) =>
            resources.map((resource) =>
              Effect.result(contactSummary(account.email, book.name, resource)),
            ),
          ),
          Effect.flatMap((parsed) => Effect.all(parsed)),
        ),
      { concurrency: addressBookConcurrency },
    );
    const results = perBook.flat();
    const contacts = results.flatMap((result) =>
      result._tag === 'Success' ? [result.success] : [],
    );
    return {
      contacts:
        query.text === undefined
          ? contacts
          : contacts.filter((contact) =>
              matchesContact(contact, query.text ?? ''),
            ),
      unreadable: results.flatMap((result) =>
        result._tag === 'Failure'
          ? [
              {
                account: account.email,
                errorTag: result.failure._tag,
                message: result.failure.message,
              },
            ]
          : [],
      ),
    };
  });

export const accountContact = (
  account: Account,
  href: string,
): Effect.Effect<
  ContactDetail & { readonly vcard: string },
  ContactsError | ContactDataError,
  Dav
> =>
  Effect.gen(function* () {
    const dav = yield* Dav;
    const client = yield* dav.client(account);
    const resource = yield* fetchContact(client, href);
    const card = yield* parseVCard(href, resource.vcard);
    const detail = yield* readContact(href, () =>
      contactDetail(card, {
        account: account.email,
        href,
        etag: resource.etag,
      }),
    );
    return { ...detail, vcard: resource.vcard };
  });
