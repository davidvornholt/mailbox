import { Effect } from 'effect';
import type { Account } from '../accounts/account';
import { AccountConfig } from '../accounts/config';
import type { UnknownAccountError } from '../errors/accounts';
import { DavNotConfiguredError } from '../errors/dav';

// The accounts a contacts command reads: the one named, or every account with
// [accounts.dav].
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
          'No account has contacts: add an [accounts.dav] table with the server DAV url to an account in the account config',
      });
    }
    return accounts;
  });
