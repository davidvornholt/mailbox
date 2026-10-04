import { Effect, Result, Schema, SchemaIssue } from 'effect';

// Keyring service namespace for stored credentials: IMAP passwords, or refresh
// tokens for Microsoft accounts. They live in the OS keyring (see
// services/secrets.ts), keyed by account email.
export const keyringService = 'mailbox';

// How an account logs in to IMAP: with a password, or with a Microsoft sign-in
// for Outlook.com and Microsoft 365, which no longer accept passwords.
const AccountAuth = Schema.Literals(['password', 'microsoft']);
export type AccountAuth = typeof AccountAuth.Type;

const implicitTlsPort = 993;
const maxPort = 65_535;

const NonEmptyTrimmedString = Schema.NonEmptyString.check(Schema.isTrimmed());

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
      accounts.map((account) => ({
        ...account,
        user: account.user ?? account.email,
      })),
    ),
    Result.mapError((error) => formatIssue(error.issue)),
  );
