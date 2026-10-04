import { Console, Effect } from 'effect';
import type { MailError } from '../features/mail/errors/errors';
import { type Account, keyringService } from '../features/mail/schemas/account';
import { Imap } from '../features/mail/services/imap';
import {
  microsoftLogin,
  type NewLogin,
  passwordLogin,
  storeVerifiedLogin,
} from '../features/mail/services/login';
import { MicrosoftAuth } from '../features/mail/services/microsoft-auth';
import { Secrets } from '../features/mail/services/secrets';
import { type HiddenPromptResult, promptHidden } from '../shared/terminal';

type LoginAttempt =
  | { readonly _tag: 'success'; readonly message: string }
  | { readonly _tag: 'skipped'; readonly message: string }
  | { readonly _tag: 'cancelled'; readonly message: string }
  | { readonly _tag: 'failed'; readonly message: string };

type LoginResult = LoginAttempt & { readonly email: string };

// A login to verify and store, or the attempt's result when there is none.
type Obtained =
  | { readonly _tag: 'obtained'; readonly login: NewLogin }
  | Extract<LoginAttempt, { readonly _tag: 'skipped' | 'cancelled' }>;

type HiddenPrompt = (question: string) => Effect.Effect<HiddenPromptResult>;

const cancelled = {
  _tag: 'cancelled',
  message: 'cancelled — remaining accounts skipped.',
} as const;

const promptPassword = (
  email: string,
  prompt: HiddenPrompt,
): Effect.Effect<Obtained> =>
  prompt(`Password for ${email} (input hidden): `).pipe(
    Effect.map((result): Obtained => {
      if (result._tag === 'cancelled') {
        return cancelled;
      }
      if (result.value === '') {
        return { _tag: 'skipped', message: 'empty password — skipped.' };
      }
      return { _tag: 'obtained', login: passwordLogin(result.value) };
    }),
  );

// The user signs in on Microsoft's page while the terminal waits. As at the
// password prompt, Enter skips the account and Ctrl-C cancels the rest.
const signInWithMicrosoft = (
  email: string,
  prompt: HiddenPrompt,
): Effect.Effect<Obtained, MailError, MicrosoftAuth> =>
  Effect.gen(function* () {
    const microsoft = yield* MicrosoftAuth;
    const device = yield* microsoft.requestDeviceCode;
    // The prompt goes first: Effect 4 starts racers in order and stops
    // starting them once one has finished, and the code must always show.
    return yield* Effect.raceFirst(
      prompt(
        `Sign in to Microsoft as ${email}: open ${device.verificationUri} and enter the code ${device.userCode}\nWaiting for sign-in (press Enter to skip): `,
      ).pipe(
        Effect.map(
          (result): Obtained =>
            result._tag === 'cancelled'
              ? cancelled
              : { _tag: 'skipped', message: 'sign-in skipped.' },
        ),
      ),
      microsoft.awaitSignIn(device).pipe(
        Effect.map(
          (tokens): Obtained => ({
            _tag: 'obtained',
            login: microsoftLogin(tokens),
          }),
        ),
      ),
    );
  });

const loginAccount = (
  account: Account,
  prompt: HiddenPrompt,
): Effect.Effect<LoginAttempt, MailError, Imap | Secrets | MicrosoftAuth> =>
  Effect.gen(function* () {
    const obtained =
      account.auth === 'password'
        ? yield* promptPassword(account.email, prompt)
        : yield* signInWithMicrosoft(account.email, prompt);
    if (obtained._tag !== 'obtained') {
      return obtained;
    }
    const secrets = yield* Secrets;
    const imap = yield* Imap;
    yield* storeVerifiedLogin(
      account.email,
      obtained.login,
      imap.verifyLogin,
      secrets.setCredential,
    );
    return {
      _tag: 'success',
      message: `verified and stored in the OS keyring (service "${keyringService}").`,
    } as const;
  });

// Logs in to each account in turn and reports every result. Resolves to true
// only when every account was stored.
export const loginAccounts = (
  accounts: ReadonlyArray<Account>,
  prompt: HiddenPrompt = promptHidden,
): Effect.Effect<boolean, never, Imap | Secrets | MicrosoftAuth> =>
  Effect.gen(function* () {
    const results: Array<LoginResult> = [];
    for (const account of accounts) {
      const result = yield* loginAccount(account, prompt).pipe(
        Effect.catch((error) =>
          Effect.succeed({ _tag: 'failed', message: error.message } as const),
        ),
      );
      results.push({ email: account.email, ...result });
      if (result._tag === 'cancelled') {
        break;
      }
    }
    yield* Effect.forEach(
      results,
      (result) =>
        result._tag === 'success'
          ? Console.log(`${result.email}: ${result.message}`)
          : Console.error(`${result.email}: ${result.message}`),
      { discard: true },
    );
    return results.every((result) => result._tag === 'success');
  });
