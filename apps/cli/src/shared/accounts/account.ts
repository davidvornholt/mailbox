import { Effect, Result, Schema, SchemaIssue } from 'effect';
import { pimClientId } from '../graph/app';

// Keyring service namespace for stored credentials. They live in the OS
// keyring (see secrets.ts), keyed by credential kind and account email.
export const keyringService = 'pim';

// How an account logs in to IMAP: with a password, or with a Microsoft sign-in
// for Outlook.com and Microsoft 365, which no longer accept passwords.
const AccountAuth = Schema.Literals(['password', 'microsoft']);
export type AccountAuth = typeof AccountAuth.Type;

const implicitTlsPort = 993;
const maxPort = 65_535;

const NonEmptyTrimmedString = Schema.NonEmptyString.check(Schema.isTrimmed());

const HttpsUrl = NonEmptyTrimmedString.check(
  Schema.makeFilter(
    (value) =>
      (URL.canParse(value) && new URL(value).protocol === 'https:') ||
      'must be an https URL',
  ),
);

// CalDAV and CardDAV access for calendars and contacts. url is the server's
// DAV root, from which commands discover the calendars and address books.
const DavEntry = Schema.Struct({
  url: HttpsUrl,
  user: Schema.optionalKey(NonEmptyTrimmedString),
});

// Outlook calendars through Microsoft Graph. client-id replaces pim's own app
// registration, as for a tenant that allows only apps it registered.
const GraphEntry = Schema.Struct({
  clientId: Schema.optionalKey(NonEmptyTrimmedString),
}).pipe(Schema.encodeKeys({ clientId: 'client-id' }));

const AccountEntry = Schema.Struct({
  email: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  host: NonEmptyTrimmedString,
  port: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maxPort }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(implicitTlsPort))),
  secure: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  user: Schema.optionalKey(NonEmptyTrimmedString),
  auth: AccountAuth.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('password' as const)),
  ),
  dav: Schema.optionalKey(DavEntry),
  graph: Schema.optionalKey(GraphEntry),
});

const formatIssue = SchemaIssue.makeFormatterDefault();

const sameEmail = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

// Emails must be unique because accounts are resolved by email.
const AccountsFile = Schema.Struct({
  accounts: Schema.NonEmptyArray(AccountEntry).check(
    Schema.makeFilter(
      (accounts) =>
        accounts.every(
          (account, index) =>
            accounts.findIndex((other) =>
              sameEmail(other.email, account.email),
            ) === index,
        ) || 'account emails must be unique',
    ),
  ),
});

export type Account = {
  readonly email: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly auth: AccountAuth;
  readonly dav?: DavSettings;
  readonly graph?: GraphSettings;
};

export type DavSettings = {
  readonly url: string;
  readonly user: string;
};

export type GraphSettings = {
  readonly clientId: string;
};

export const findAccount = (
  accounts: ReadonlyArray<Account>,
  email: string,
): Account | undefined =>
  accounts.find((account) => sameEmail(account.email, email.trim()));

// Unknown keys are rejected so a typo such as `hots` fails loudly instead of
// silently falling back to a default.
export const decodeAccounts = (
  input: unknown,
): Result.Result<ReadonlyArray<Account>, string> =>
  Schema.decodeUnknownResult(AccountsFile)(input, {
    errors: 'all',
    onExcessProperty: 'error',
  }).pipe(
    Result.map(({ accounts }) =>
      accounts.map(({ dav, graph, ...account }) => {
        const user = account.user ?? account.email;
        return {
          ...account,
          user,
          ...(dav === undefined
            ? {}
            : { dav: { ...dav, user: dav.user ?? user } }),
          ...(graph === undefined
            ? {}
            : { graph: { clientId: graph.clientId ?? pimClientId } }),
        };
      }),
    ),
    Result.mapError((error) => formatIssue(error.issue)),
  );
