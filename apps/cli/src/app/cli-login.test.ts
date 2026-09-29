import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { Account } from '../features/mail/schemas/account';
import { Imap } from '../features/mail/services/imap';
import type { ImapLogin } from '../features/mail/services/imap-client';
import {
  type DeviceCode,
  MicrosoftAuth,
  type MicrosoftTokens,
} from '../features/mail/services/microsoft-auth';
import { Secrets } from '../features/mail/services/secrets';
import type { HiddenPromptResult } from '../shared/terminal';
import { loginAccounts } from './cli-login';

const accountFor = (email: string, auth: Account['auth']): Account => ({
  email,
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: email,
  auth,
});

const device: DeviceCode = {
  deviceCode: 'device-code',
  userCode: 'ABCD1234',
  verificationUri: 'https://login.microsoft.com/device',
  intervalSeconds: 5,
  expiresInSeconds: 900,
};

// Runs loginAccounts against recording fakes. `signIn` settles the Microsoft
// sign-in and `answer` settles each prompt.
const runLogin = async (
  accounts: ReadonlyArray<Account>,
  options: {
    readonly answer: Effect.Effect<HiddenPromptResult>;
    readonly signIn?: Effect.Effect<MicrosoftTokens>;
  },
) => {
  const prompts: Array<string> = [];
  const verified: Array<ImapLogin> = [];
  const stored: Array<string> = [];
  const prompt = (question: string): Effect.Effect<HiddenPromptResult> =>
    Effect.sync(() => prompts.push(question)).pipe(
      Effect.andThen(options.answer),
    );
  const imap = {
    verifyLogin: (_email: string, login: ImapLogin) =>
      Effect.sync(() => {
        verified.push(login);
      }),
  } as unknown as Imap;
  const secrets = {
    setCredential: (_email: string, credential: string) =>
      Effect.sync(() => {
        stored.push(credential);
      }),
  } as unknown as Secrets;
  const microsoft = {
    requestDeviceCode: Effect.succeed(device),
    awaitSignIn: () => options.signIn ?? Effect.never,
  } as unknown as MicrosoftAuth;

  const succeeded = await Effect.runPromise(
    loginAccounts(accounts, prompt).pipe(
      Effect.provideService(Imap, imap),
      Effect.provideService(Secrets, secrets),
      Effect.provideService(MicrosoftAuth, microsoft),
    ),
  );
  return { succeeded, prompts, verified, stored };
};

describe('loginAccounts', () => {
  it('stops prompting and does not verify or store after cancellation', async () => {
    const result = await runLogin(
      [
        accountFor('first@example.com', 'password'),
        accountFor('second@example.com', 'password'),
      ],
      { answer: Effect.succeed({ _tag: 'cancelled' }) },
    );

    expect(result.prompts).toEqual([
      'Password for first@example.com (input hidden): ',
    ]);
    expect(result.verified).toEqual([]);
    expect(result.stored).toEqual([]);
    expect(result.succeeded).toBeFalse();
  });

  it('shows the Microsoft code, then verifies the access token and stores the refresh token', async () => {
    const result = await runLogin([accountFor('me@outlook.com', 'microsoft')], {
      answer: Effect.never,
      signIn: Effect.succeed({
        accessToken: 'access',
        refreshToken: 'refresh',
      }),
    });

    expect(result.prompts).toEqual([
      'Sign in to Microsoft as me@outlook.com: open https://login.microsoft.com/device and enter the code ABCD1234\nWaiting for sign-in (press Enter to skip): ',
    ]);
    expect(result.verified).toEqual([{ accessToken: 'access' }]);
    expect(result.stored).toEqual(['refresh']);
    expect(result.succeeded).toBeTrue();
  });

  it('skips a Microsoft account when Enter is pressed before sign-in', async () => {
    const result = await runLogin([accountFor('me@outlook.com', 'microsoft')], {
      answer: Effect.succeed({ _tag: 'entered', value: '' }),
    });

    expect(result.verified).toEqual([]);
    expect(result.stored).toEqual([]);
    expect(result.succeeded).toBeFalse();
  });
});
