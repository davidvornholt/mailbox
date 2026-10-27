import { Effect } from 'effect';
import type { Account } from '../accounts/account';
import { AccountConfig } from '../accounts/config';
import type { UnknownAccountError } from '../errors/accounts';
import { DavAccountsError, DavNotConfiguredError } from '../errors/dav';

export type AccountFailure = {
  readonly account: string;
  readonly errorTag: string;
  readonly message: string;
};

export type AcrossAccounts<A> = {
  readonly results: ReadonlyArray<A>;
  readonly failures: ReadonlyArray<AccountFailure>;
};

const accountConcurrency = 5;

// The accounts a calendar or contacts command reads: the one named, or every
// account with [accounts.dav].
export const davAccounts = (
  only: string | undefined,
): Effect.Effect<
  ReadonlyArray<Account>,
  DavNotConfiguredError | UnknownAccountError,
  AccountConfig
> =>
  Effect.gen(function* () {
    const config = yield* AccountConfig;
    if (only !== undefined) {
      return [yield* config.getAccount(only)];
    }
    const accounts = config.accounts.filter(
      (account) => account.dav !== undefined,
    );
    if (accounts.length === 0) {
      return yield* new DavNotConfiguredError({
        message:
          'No account has calendars or contacts: add an [accounts.dav] table with the server DAV url to an account in the account config',
      });
    }
    return accounts;
  });

// Runs `run` for each account and collects one result per account. With one
// account its error is the command's error; with several, failed accounts are
// listed beside the other results, and the command fails only when every
// account failed.
export const acrossAccounts = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  accounts: ReadonlyArray<Account>,
  run: (account: Account) => Effect.Effect<A, E, R>,
): Effect.Effect<AcrossAccounts<A>, E | DavAccountsError, R> =>
  Effect.gen(function* () {
    const [single] = accounts;
    if (accounts.length === 1 && single !== undefined) {
      return { results: [yield* run(single)], failures: [] };
    }
    const outcomes = yield* Effect.forEach(
      accounts,
      (account) =>
        run(account).pipe(
          Effect.result,
          Effect.map((result) => ({ account: account.email, result })),
        ),
      { concurrency: accountConcurrency },
    );
    const results: Array<A> = [];
    const failures: Array<AccountFailure> = [];
    for (const { account, result } of outcomes) {
      if (result._tag === 'Success') {
        results.push(result.success);
      } else {
        failures.push({
          account,
          errorTag: result.failure._tag,
          message: result.failure.message,
        });
      }
    }
    if (failures.length === accounts.length) {
      return yield* new DavAccountsError({
        message: `Every account failed. ${failures.map(({ account, message }) => `${account}: ${message}`).join('; ')}`,
      });
    }
    return { results, failures };
  });
