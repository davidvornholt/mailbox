import { Duration, Effect } from 'effect';
import { ImapError, type MailError } from '../errors/errors';
import type { AccountStatus } from '../schemas/mail';
import { Imap } from './imap';
import { Secrets } from './secrets';

// Cap each IMAP verification so one unreachable server can't stall the report.
const verifyTimeoutSeconds = 20;
const verifyTimeout = Duration.seconds(verifyTimeoutSeconds);
// Verify a handful of accounts at once without opening too many sockets.
const verifyConcurrency = 5;

// Map a failed check to a status. Kept pure so the categorization is unit
// testable without a live IMAP connection.
export const statusFromError = (
  email: string,
  error: MailError,
): AccountStatus => {
  switch (error._tag) {
    case 'MissingCredentialsError':
      return {
        email,
        ok: false,
        state: 'no-credentials',
        message: `no credentials stored; run: mailbox login --account ${email}`,
      };
    case 'ImapError':
    case 'OAuthError':
      return {
        email,
        ok: false,
        state: 'unauthenticated',
        message: error.message,
      };
    default:
      return { email, ok: false, state: 'error', message: error.message };
  }
};

const verifyOne = (
  email: string,
): Effect.Effect<AccountStatus, never, Imap | Secrets> =>
  Effect.gen(function* () {
    const imap = yield* Imap;
    return yield* imap.verify(email).pipe(
      Effect.timeoutOrElse({
        duration: verifyTimeout,
        orElse: () =>
          Effect.fail(new ImapError({ message: 'connection timed out' })),
      }),
      Effect.match({
        onSuccess: () =>
          ({
            email,
            ok: true,
            state: 'authenticated',
            message: 'authenticated',
          }) as const,
        onFailure: (error) => statusFromError(email, error),
      }),
    );
  });

const keyringOne = (
  email: string,
): Effect.Effect<AccountStatus, never, Imap | Secrets> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    return yield* secrets.getCredential(email).pipe(
      Effect.match({
        onSuccess: () =>
          ({
            email,
            ok: true,
            state: 'credentials-stored',
            message: 'credentials stored (not verified)',
          }) as const,
        onFailure: (error) => statusFromError(email, error),
      }),
    );
  });

// Report the auth state of each account. `verify: true` connects to each IMAP
// server to prove the stored credentials work; `verify: false` only checks the
// keyring (fast, offline).
export const checkAccounts = (
  emails: ReadonlyArray<string>,
  options: { readonly verify: boolean },
): Effect.Effect<ReadonlyArray<AccountStatus>, never, Imap | Secrets> =>
  Effect.forEach(
    emails,
    (email) => (options.verify ? verifyOne(email) : keyringOne(email)),
    { concurrency: verifyConcurrency },
  );
