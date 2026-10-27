import { Entry } from '@napi-rs/keyring';
import { Context, Effect, Layer } from 'effect';
import { KeyringError, MissingCredentialsError } from '../errors/accounts';
import { keyringService } from './account';

// What a stored credential logs in to. mail is the IMAP password, or the
// refresh token of a Microsoft sign-in; dav is the CalDAV and CardDAV password.
export type CredentialKind = 'mail' | 'dav';

// Each credential lives in the keyring under <kind>:<email>.
const entry = (kind: CredentialKind, account: string): Entry =>
  new Entry(keyringService, `${kind}:${account}`);

export const loginCommand = (kind: CredentialKind, account: string): string =>
  `pim login --account ${account} --only ${kind}`;

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly getCredential: (
      kind: CredentialKind,
      account: string,
    ) => Effect.Effect<string, MissingCredentialsError | KeyringError>;
    readonly setCredential: (
      kind: CredentialKind,
      account: string,
      credential: string,
    ) => Effect.Effect<void, KeyringError>;
  }
>()('shared/Secrets') {
  static readonly layer = Layer.succeed(
    Secrets,
    Secrets.of({
      getCredential: (
        kind: CredentialKind,
        account: string,
      ): Effect.Effect<string, MissingCredentialsError | KeyringError> =>
        Effect.try({
          try: () => entry(kind, account).getPassword(),
          catch: (cause) =>
            new KeyringError({
              message: `keyring read failed for ${kind}:${account}: ${String(cause)}`,
            }),
        }).pipe(
          Effect.flatMap((credential) =>
            credential === null
              ? Effect.fail(
                  new MissingCredentialsError({
                    account,
                    message: `No stored ${kind} credentials for ${account}. Ask the user to run: ${loginCommand(kind, account)}`,
                  }),
                )
              : Effect.succeed(credential),
          ),
        ),
      setCredential: (
        kind: CredentialKind,
        account: string,
        credential: string,
      ): Effect.Effect<void, KeyringError> =>
        Effect.try({
          try: () => {
            entry(kind, account).setPassword(credential);
          },
          catch: (cause) =>
            new KeyringError({
              message: `keyring write failed for ${kind}:${account}: ${String(cause)}`,
            }),
        }),
    }),
  );
}
