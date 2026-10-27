import { Duration, Effect } from 'effect';
import type { Secrets } from '../../../shared/accounts/secrets';
import {
  authenticatedStatus,
  type CredentialStatus,
  failedStatus,
  missingCredentialStatus,
  storedCredentialStatus,
} from '../../../shared/accounts/status';
import { ImapError, type MailError } from '../errors/errors';
import { Imap } from './imap';

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
): CredentialStatus => {
  switch (error._tag) {
    case 'MissingCredentialsError':
      return missingCredentialStatus('mail', email);
    case 'ImapError':
    case 'OAuthError':
      return failedStatus('mail', email, 'unauthenticated', error.message);
    default:
      return failedStatus('mail', email, 'error', error.message);
  }
};

const verifyOne = (
  email: string,
): Effect.Effect<CredentialStatus, never, Imap | Secrets> =>
  Effect.gen(function* () {
    const imap = yield* Imap;
    return yield* imap.verify(email).pipe(
      Effect.timeoutOrElse({
        duration: verifyTimeout,
        orElse: () =>
          Effect.fail(new ImapError({ message: 'connection timed out' })),
      }),
      Effect.match({
        onSuccess: () => authenticatedStatus('mail', email),
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
): Effect.Effect<ReadonlyArray<CredentialStatus>, never, Imap | Secrets> =>
  Effect.forEach(
    emails,
    (email) =>
      options.verify ? verifyOne(email) : storedCredentialStatus('mail', email),
    { concurrency: verifyConcurrency },
  );
