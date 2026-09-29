import { Entry } from '@napi-rs/keyring';
import { Effect } from 'effect';
import { KeyringError, MissingCredentialsError } from '../errors/errors';
import { keyringService } from '../schemas/account';

// Each account keeps one credential in the keyring: its IMAP password, or the
// refresh token of its Microsoft sign-in.
export class Secrets extends Effect.Service<Secrets>()('mail/Secrets', {
  succeed: {
    getCredential: (
      account: string,
    ): Effect.Effect<string, MissingCredentialsError | KeyringError> =>
      Effect.try({
        try: () => new Entry(keyringService, account).getPassword(),
        catch: (cause) =>
          new KeyringError({
            message: `keyring read failed for ${account}: ${String(cause)}`,
          }),
      }).pipe(
        Effect.flatMap((credential) =>
          credential === null
            ? Effect.fail(
                new MissingCredentialsError({
                  account,
                  message: `No stored credentials for ${account}. Ask the user to run: mailbox login --account ${account}`,
                }),
              )
            : Effect.succeed(credential),
        ),
      ),
    setCredential: (
      account: string,
      credential: string,
    ): Effect.Effect<void, KeyringError> =>
      Effect.try({
        try: () => {
          new Entry(keyringService, account).setPassword(credential);
        },
        catch: (cause) =>
          new KeyringError({
            message: `keyring write failed for ${account}: ${String(cause)}`,
          }),
      }),
  },
}) {}
