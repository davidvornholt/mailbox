import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { ImapError, OAuthError } from '../errors/errors';
import type { Account } from '../schemas/account';
import type { ImapLogin } from './imap-client';
import { imapLoginFor, passwordLogin, storeVerifiedLogin } from './login';

const account: Account = {
  email: 'me@example.com',
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
  auth: 'password',
};

describe('storeVerifiedLogin', () => {
  it('stores the password after successful verification', async () => {
    const events: Array<string> = [];

    await Effect.runPromise(
      storeVerifiedLogin(
        'user@example.com',
        passwordLogin('secret'),
        (_email, login) =>
          Effect.sync(() => events.push(`verified ${JSON.stringify(login)}`)),
        (_email, credential) =>
          Effect.sync(() => events.push(`stored ${credential}`)),
      ),
    );

    expect(events).toEqual(['verified {"pass":"secret"}', 'stored secret']);
  });

  it('does not store the credential when verification fails', async () => {
    let stored = false;
    const program = storeVerifiedLogin(
      'user@example.com',
      passwordLogin('wrong'),
      () => Effect.fail(new ImapError({ message: 'authentication failed' })),
      () =>
        Effect.sync(() => {
          stored = true;
        }),
    );

    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe('Failure');
    expect(stored).toBeFalse();
  });
});

describe('imapLoginFor', () => {
  const credentialsWith = (
    refresh: (
      email: string,
      refreshToken: string,
    ) => Effect.Effect<
      { readonly accessToken: string; readonly refreshToken: string },
      OAuthError
    >,
  ) => {
    const stored: Array<string> = [];
    const refreshed: Array<string> = [];
    return {
      stored,
      refreshed,
      credentials: {
        get: () => Effect.succeed('stored-credential'),
        store: (_email: string, credential: string) =>
          Effect.sync(() => {
            stored.push(credential);
          }),
        refresh: (email: string, refreshToken: string) =>
          Effect.sync(() => refreshed.push(refreshToken)).pipe(
            Effect.andThen(refresh(email, refreshToken)),
          ),
      },
    };
  };
  const loginFor = (
    auth: Account['auth'],
    credentials: Parameters<typeof imapLoginFor>[1],
  ): Promise<ImapLogin> =>
    Effect.runPromise(imapLoginFor({ ...account, auth }, credentials));

  it('logs in to a password account with the stored password', async () => {
    const { credentials, refreshed } = credentialsWith(() =>
      Effect.succeed({ accessToken: 'unused', refreshToken: 'unused' }),
    );

    expect(await loginFor('password', credentials)).toEqual({
      pass: 'stored-credential',
    });
    expect(refreshed).toEqual([]);
  });

  it('trades the refresh token for an access token and keeps the rotated one', async () => {
    const { credentials, refreshed, stored } = credentialsWith(() =>
      Effect.succeed({ accessToken: 'access', refreshToken: 'rotated' }),
    );

    expect(await loginFor('microsoft', credentials)).toEqual({
      accessToken: 'access',
    });
    expect(refreshed).toEqual(['stored-credential']);
    expect(stored).toEqual(['rotated']);
  });

  it('does not rewrite the keyring when the refresh token did not change', async () => {
    const { credentials, stored } = credentialsWith((_email, refreshToken) =>
      Effect.succeed({ accessToken: 'access', refreshToken }),
    );

    await loginFor('microsoft', credentials);

    expect(stored).toEqual([]);
  });

  it('fails without touching the keyring when Microsoft rejects the refresh', async () => {
    const { credentials, stored } = credentialsWith(() =>
      Effect.fail(new OAuthError({ message: 'revoked' })),
    );

    const result = await Effect.runPromise(
      Effect.flip(imapLoginFor({ ...account, auth: 'microsoft' }, credentials)),
    );

    expect(result).toMatchObject({ _tag: 'OAuthError', message: 'revoked' });
    expect(stored).toEqual([]);
  });
});
