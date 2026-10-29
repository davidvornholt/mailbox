import { Context, Effect, Layer } from 'effect';
import type { Account, GraphSettings } from '../accounts/account';
import { Secrets } from '../accounts/secrets';
import type {
  KeyringError,
  MissingCredentialsError,
  OAuthError,
} from '../errors/accounts';
import { GraphNotConfiguredError } from '../errors/graph';
import { freshAccessToken, MicrosoftAuth } from '../microsoft/auth';
import { graphApp } from './app';
import { type GraphClient, type GraphFetch, makeGraphClient } from './client';

export type GraphSessionError =
  | GraphNotConfiguredError
  | MissingCredentialsError
  | KeyringError
  | OAuthError;

export const graphSettings = (
  account: Account,
): Effect.Effect<GraphSettings, GraphNotConfiguredError> =>
  account.graph === undefined
    ? Effect.fail(
        new GraphNotConfiguredError({
          message: `${account.email} has no Outlook calendars: its account config has no graph table`,
        }),
      )
    : Effect.succeed(account.graph);

export const makeGraph = (fetch: GraphFetch) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const microsoft = yield* MicrosoftAuth;
    const clientWith = (account: Account, accessToken: string) =>
      makeGraphClient({ account: account.email, accessToken }, fetch);
    return Graph.of({
      clientWith,
      client: (account) =>
        Effect.gen(function* () {
          const app = graphApp((yield* graphSettings(account)).clientId);
          const stored = yield* secrets.getCredential('graph', account.email);
          const accessToken = yield* freshAccessToken(stored, {
            refresh: (refreshToken) =>
              microsoft.refresh(app, account.email, refreshToken),
            store: (refreshToken) =>
              secrets.setCredential('graph', account.email, refreshToken),
          });
          return clientWith(account, accessToken);
        }),
    });
  });

export class Graph extends Context.Service<
  Graph,
  {
    // A client that signs in with the account's stored Microsoft sign-in.
    readonly client: (
      account: Account,
    ) => Effect.Effect<GraphClient, GraphSessionError>;
    // A client for an access token that is not stored yet, to verify it.
    readonly clientWith: (account: Account, accessToken: string) => GraphClient;
  }
>()('shared/Graph') {
  static readonly layer = Layer.effect(
    Graph,
    makeGraph((url, init) =>
      fetch(url, {
        method: 'GET',
        headers: { ...init.headers },
        signal: init.signal,
      }),
    ),
  ).pipe(Layer.provide([Secrets.layer, MicrosoftAuth.layer]));
}
