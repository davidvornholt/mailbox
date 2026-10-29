import { Effect, Schema } from 'effect';
import type { Account } from '../accounts/account';
import type { Secrets } from '../accounts/secrets';
import {
  authenticatedStatus,
  type CredentialStatus,
  failedStatus,
  missingCredentialStatus,
  storedCredentialStatus,
} from '../accounts/status';
import type { GraphRequestError } from '../errors/graph';
import type { GraphClient } from './client';
import { Graph, type GraphSessionError } from './graph';

// Check a handful of accounts at once without flooding Microsoft Graph.
const checkConcurrency = 5;

// A read every signed-in account may make, which proves that the sign-in
// works and grants calendar access.
export const verifyGraph = (
  client: GraphClient,
): Effect.Effect<void, GraphRequestError> =>
  client.get('/me/calendars?$top=1&$select=id', Schema.Unknown);

export const graphStatusFromError = (
  email: string,
  error: GraphSessionError | GraphRequestError,
): CredentialStatus => {
  switch (error._tag) {
    case 'MissingCredentialsError':
      return missingCredentialStatus('graph', email);
    case 'OAuthError':
    case 'GraphAuthError':
      return failedStatus('graph', email, 'unauthenticated', error.message);
    default:
      return failedStatus('graph', email, 'error', error.message);
  }
};

const verifyOne = (
  account: Account,
): Effect.Effect<CredentialStatus, never, Graph> =>
  Graph.pipe(
    Effect.flatMap((graph) => graph.client(account)),
    Effect.flatMap(verifyGraph),
    Effect.match({
      onSuccess: () => authenticatedStatus('graph', account.email),
      onFailure: (error) => graphStatusFromError(account.email, error),
    }),
  );

// Reports the Microsoft Graph sign-in of each account that has
// a graph table. `verify: true` reads from Microsoft Graph; `verify:
// false` only checks the keyring.
export const checkGraphAccounts = (
  accounts: ReadonlyArray<Account>,
  options: { readonly verify: boolean },
): Effect.Effect<ReadonlyArray<CredentialStatus>, never, Graph | Secrets> =>
  Effect.forEach(
    accounts.filter((account) => account.graph !== undefined),
    (account): Effect.Effect<CredentialStatus, never, Graph | Secrets> =>
      options.verify
        ? verifyOne(account)
        : storedCredentialStatus('graph', account.email),
    { concurrency: checkConcurrency },
  );
