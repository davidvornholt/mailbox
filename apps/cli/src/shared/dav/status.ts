import { Effect } from 'effect';
import type { Account } from '../accounts/account';
import type { Secrets } from '../accounts/secrets';
import {
  authenticatedStatus,
  type CredentialStatus,
  failedStatus,
  missingCredentialStatus,
  storedCredentialStatus,
} from '../accounts/status';
import type { DavRequestError } from '../errors/dav';
import { Dav, type DavSessionError } from './dav';
import { currentUserPrincipal } from './discovery';

// Check a handful of accounts at once without flooding the servers.
const checkConcurrency = 5;

export const davStatusFromError = (
  email: string,
  error: DavSessionError | DavRequestError,
): CredentialStatus => {
  switch (error._tag) {
    case 'MissingCredentialsError':
      return missingCredentialStatus('dav', email);
    case 'DavAuthError':
      return failedStatus('dav', email, 'unauthenticated', error.message);
    default:
      return failedStatus('dav', email, 'error', error.message);
  }
};

const verifyOne = (
  account: Account,
): Effect.Effect<CredentialStatus, never, Dav> =>
  Dav.pipe(
    Effect.flatMap((dav) => dav.client(account)),
    Effect.flatMap(currentUserPrincipal),
    Effect.match({
      onSuccess: () => authenticatedStatus('dav', account.email),
      onFailure: (error) => davStatusFromError(account.email, error),
    }),
  );

// Reports the DAV login of each account that has a dav table. `verify:
// true` asks each server who is signed in; `verify: false` only checks the
// keyring.
export const checkDavAccounts = (
  accounts: ReadonlyArray<Account>,
  options: { readonly verify: boolean },
): Effect.Effect<ReadonlyArray<CredentialStatus>, never, Dav | Secrets> =>
  Effect.forEach(
    accounts.filter((account) => account.dav !== undefined),
    (account): Effect.Effect<CredentialStatus, never, Dav | Secrets> =>
      options.verify
        ? verifyOne(account)
        : storedCredentialStatus('dav', account.email),
    { concurrency: checkConcurrency },
  );
