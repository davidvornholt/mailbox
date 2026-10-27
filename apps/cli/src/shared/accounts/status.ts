import { Effect } from 'effect';
import { type CredentialKind, loginCommand, Secrets } from './secrets';

export type CredentialState =
  | 'authenticated'
  | 'credentials-stored'
  | 'no-credentials'
  | 'unauthenticated'
  | 'error';

// Whether one account can log in to one service, as `pim status` reports it.
export type CredentialStatus = {
  readonly email: string;
  readonly service: CredentialKind;
  readonly ok: boolean;
  readonly state: CredentialState;
  readonly message: string;
};

export const authenticatedStatus = (
  service: CredentialKind,
  email: string,
): CredentialStatus => ({
  email,
  service,
  ok: true,
  state: 'authenticated',
  message: 'authenticated',
});

export const failedStatus = (
  service: CredentialKind,
  email: string,
  state: Exclude<CredentialState, 'authenticated' | 'credentials-stored'>,
  message: string,
): CredentialStatus => ({ email, service, ok: false, state, message });

export const missingCredentialStatus = (
  service: CredentialKind,
  email: string,
): CredentialStatus =>
  failedStatus(
    service,
    email,
    'no-credentials',
    `no ${service} credentials stored; run: ${loginCommand(service, email)}`,
  );

// Checks only the keyring, without connecting to the server.
export const storedCredentialStatus = (
  service: CredentialKind,
  email: string,
): Effect.Effect<CredentialStatus, never, Secrets> =>
  Secrets.pipe(
    Effect.flatMap((secrets) => secrets.getCredential(service, email)),
    Effect.match({
      onSuccess: (): CredentialStatus => ({
        email,
        service,
        ok: true,
        state: 'credentials-stored',
        message: 'credentials stored (not verified)',
      }),
      onFailure: (error) =>
        error._tag === 'MissingCredentialsError'
          ? missingCredentialStatus(service, email)
          : failedStatus(service, email, 'error', error.message),
    }),
  );
