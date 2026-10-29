import { Context, Effect, Layer } from 'effect';
import type { Account, DavSettings } from '../accounts/account';
import { Secrets } from '../accounts/secrets';
import type { KeyringError, MissingCredentialsError } from '../errors/accounts';
import { DavNotConfiguredError } from '../errors/dav';
import { type DavClient, type Fetch, makeDavClient } from './client';

export type DavSessionError =
  | DavNotConfiguredError
  | MissingCredentialsError
  | KeyringError;

export const davSettings = (
  account: Account,
): Effect.Effect<DavSettings, DavNotConfiguredError> =>
  account.dav === undefined
    ? Effect.fail(
        new DavNotConfiguredError({
          message: `${account.email} has no calendars or contacts: its account config has no dav table with the server's DAV url`,
        }),
      )
    : Effect.succeed(account.dav);

const makeDav = (fetch: Fetch) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const clientWith = (account: Account, password: string) =>
      davSettings(account).pipe(
        Effect.map((settings) =>
          makeDavClient(
            { ...settings, account: account.email, password },
            fetch,
          ),
        ),
      );
    return Dav.of({
      clientWith,
      client: (account) =>
        davSettings(account).pipe(
          Effect.andThen(secrets.getCredential('dav', account.email)),
          Effect.flatMap((password) => clientWith(account, password)),
        ),
    });
  });

export class Dav extends Context.Service<
  Dav,
  {
    // A client that logs in with the account's stored DAV password.
    readonly client: (
      account: Account,
    ) => Effect.Effect<DavClient, DavSessionError>;
    // A client for a password that is not stored yet, to verify it first.
    readonly clientWith: (
      account: Account,
      password: string,
    ) => Effect.Effect<DavClient, DavNotConfiguredError>;
  }
>()('shared/Dav') {
  static readonly layer = Layer.effect(
    Dav,
    makeDav((url, init) => fetch(url, init)),
  ).pipe(Layer.provide(Secrets.layer));
}
