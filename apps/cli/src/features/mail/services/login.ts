import { Effect } from 'effect';
import type { MailError } from '../errors/errors';
import type { Account } from '../schemas/account';
import type { ImapLogin } from './imap-client';
import type { MicrosoftTokens } from './microsoft-auth';

type VerifyLogin = (
  email: string,
  login: ImapLogin,
) => Effect.Effect<void, MailError>;

type GetCredential = (email: string) => Effect.Effect<string, MailError>;

type StoreCredential = (
  email: string,
  credential: string,
) => Effect.Effect<void, MailError>;

type RefreshTokens = (
  email: string,
  refreshToken: string,
) => Effect.Effect<MicrosoftTokens, MailError>;

// A login obtained by `mailbox login`: what IMAP checks now, and what the
// keyring keeps for later commands.
export type NewLogin = {
  readonly imap: ImapLogin;
  readonly credential: string;
};

export const passwordLogin = (password: string): NewLogin => ({
  imap: { pass: password },
  credential: password,
});

export const microsoftLogin = (tokens: MicrosoftTokens): NewLogin => ({
  imap: { accessToken: tokens.accessToken },
  credential: tokens.refreshToken,
});

// Verification intentionally precedes persistence so a failed login cannot
// replace a working credential in the keyring.
export const storeVerifiedLogin = (
  email: string,
  login: NewLogin,
  verifyLogin: VerifyLogin,
  storeCredential: StoreCredential,
): Effect.Effect<void, MailError> =>
  verifyLogin(email, login.imap).pipe(
    Effect.andThen(storeCredential(email, login.credential)),
  );

// Turns the stored credential into an IMAP login. A Microsoft access token
// lasts about an hour, so each command trades the stored refresh token for a
// new one. Keeping the rotated refresh token extends the sign-in, which would
// otherwise expire 90 days after `mailbox login`.
export const imapLoginFor = (
  account: Account,
  credentials: {
    readonly get: GetCredential;
    readonly store: StoreCredential;
    readonly refresh: RefreshTokens;
  },
): Effect.Effect<ImapLogin, MailError> =>
  Effect.gen(function* () {
    const credential = yield* credentials.get(account.email);
    if (account.auth === 'password') {
      return { pass: credential };
    }
    const tokens = yield* credentials.refresh(account.email, credential);
    if (tokens.refreshToken !== credential) {
      yield* credentials.store(account.email, tokens.refreshToken);
    }
    return { accessToken: tokens.accessToken };
  });
