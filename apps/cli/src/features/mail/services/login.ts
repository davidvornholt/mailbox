import { Effect } from 'effect';
import type { MailAccount } from '../../../shared/accounts/account';
import {
  freshAccessToken,
  type MicrosoftApp,
  type MicrosoftTokens,
} from '../../../shared/microsoft/auth';
import type { MailError } from '../errors/errors';
import type { ImapLogin } from './imap-client';

// Microsoft issues tokens only to registered apps. IMAP borrows Mozilla
// Thunderbird's public client ID, which works for personal and most work or
// school accounts without an app registration of its own, so Microsoft's
// consent screen names Thunderbird.
export const imapApp: MicrosoftApp = {
  clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
  scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
  credential: 'mail',
};

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

// A login obtained by `pim login`: what IMAP checks now, and what the
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

// Turns the stored credential, a password or a Microsoft refresh token, into
// an IMAP login.
export const imapLoginFor = (
  account: MailAccount,
  credentials: {
    readonly get: GetCredential;
    readonly store: StoreCredential;
    readonly refresh: RefreshTokens;
  },
): Effect.Effect<ImapLogin, MailError> =>
  Effect.gen(function* () {
    const credential = yield* credentials.get(account.email);
    if (account.mail.auth === 'password') {
      return { pass: credential };
    }
    const accessToken = yield* freshAccessToken(credential, {
      refresh: (refreshToken) =>
        credentials.refresh(account.email, refreshToken),
      store: (refreshToken) => credentials.store(account.email, refreshToken),
    });
    return { accessToken };
  });
