import { Console, Effect } from 'effect';
import type { MailError } from '../features/mail/errors/errors';
import { Imap } from '../features/mail/services/imap';
import {
  imapApp,
  microsoftLogin,
  type NewLogin,
  passwordLogin,
  storeVerifiedLogin,
} from '../features/mail/services/login';
import { type Account, keyringService } from '../shared/accounts/account';
import { type CredentialKind, Secrets } from '../shared/accounts/secrets';
import { Dav } from '../shared/dav/dav';
import { currentUserPrincipal } from '../shared/dav/discovery';
import type { KeyringError, OAuthError } from '../shared/errors/accounts';
import type {
  DavNotConfiguredError,
  DavRequestError,
} from '../shared/errors/dav';
import type {
  GraphNotConfiguredError,
  GraphRequestError,
} from '../shared/errors/graph';
import { graphApp } from '../shared/graph/app';
import { Graph, graphSettings } from '../shared/graph/graph';
import { verifyGraph } from '../shared/graph/status';
import {
  type MicrosoftApp,
  MicrosoftAuth,
  type MicrosoftTokens,
} from '../shared/microsoft/auth';
import { type HiddenPromptResult, promptHidden } from '../shared/terminal';

type LoginAttempt =
  | { readonly _tag: 'success'; readonly message: string }
  | { readonly _tag: 'skipped'; readonly message: string }
  | { readonly _tag: 'cancelled'; readonly message: string }
  | { readonly _tag: 'failed'; readonly message: string };

type LoginResult = LoginAttempt & {
  readonly email: string;
  readonly service: CredentialKind;
};

// One credential to obtain, verify, and store.
export type LoginStep = {
  readonly account: Account;
  readonly service: CredentialKind;
};

// A login to verify and store, or the attempt's result when there is none.
type Obtained<A> =
  | { readonly _tag: 'obtained'; readonly login: A }
  | Extract<LoginAttempt, { readonly _tag: 'skipped' | 'cancelled' }>;

type HiddenPrompt = (question: string) => Effect.Effect<HiddenPromptResult>;

const cancelled = {
  _tag: 'cancelled',
  message: 'cancelled — remaining logins skipped.',
} as const;

const stored = {
  _tag: 'success',
  message: `verified and stored in the OS keyring (service "${keyringService}").`,
} as const;

const promptPassword = (
  question: string,
  prompt: HiddenPrompt,
): Effect.Effect<Obtained<string>> =>
  prompt(question).pipe(
    Effect.map((result): Obtained<string> => {
      if (result._tag === 'cancelled') {
        return cancelled;
      }
      if (result.value === '') {
        return { _tag: 'skipped', message: 'empty password — skipped.' };
      }
      return { _tag: 'obtained', login: result.value };
    }),
  );

// The user signs in on Microsoft's page while the terminal waits. As at the
// password prompt, Enter skips the account and Ctrl-C cancels the rest.
const awaitMicrosoftSignIn = (
  question: string,
  prompt: HiddenPrompt,
  signIn: Effect.Effect<MicrosoftTokens, OAuthError>,
): Effect.Effect<Obtained<MicrosoftTokens>, OAuthError> =>
  // The prompt goes first: Effect 4 starts racers in order and stops starting
  // them once one has finished, and the instructions must always show.
  Effect.raceFirst(
    prompt(`${question}\nWaiting for sign-in (press Enter to skip): `).pipe(
      Effect.map(
        (result): Obtained<MicrosoftTokens> =>
          result._tag === 'cancelled'
            ? cancelled
            : { _tag: 'skipped', message: 'sign-in skipped.' },
      ),
    ),
    signIn.pipe(
      Effect.map(
        (tokens): Obtained<MicrosoftTokens> => ({
          _tag: 'obtained',
          login: tokens,
        }),
      ),
    ),
  );

const signInWithDeviceCode = (
  app: MicrosoftApp,
  greeting: string,
  prompt: HiddenPrompt,
): Effect.Effect<Obtained<MicrosoftTokens>, OAuthError, MicrosoftAuth> =>
  Effect.gen(function* () {
    const microsoft = yield* MicrosoftAuth;
    const device = yield* microsoft.requestDeviceCode(app);
    return yield* awaitMicrosoftSignIn(
      `${greeting}: open ${device.verificationUri} and enter the code ${device.userCode}`,
      prompt,
      microsoft.awaitSignIn(app, device),
    );
  });

const signInInBrowser = (
  app: MicrosoftApp,
  email: string,
  greeting: string,
  prompt: HiddenPrompt,
): Effect.Effect<Obtained<MicrosoftTokens>, OAuthError, MicrosoftAuth> =>
  Effect.gen(function* () {
    const microsoft = yield* MicrosoftAuth;
    const signIn = yield* microsoft.signInInBrowser(app, email);
    return yield* awaitMicrosoftSignIn(
      `${greeting}: open this link in a browser on this computer:\n${signIn.url}`,
      prompt,
      signIn.awaitSignIn,
    );
  }).pipe(Effect.scoped);

const loginMail = (
  account: Account,
  prompt: HiddenPrompt,
): Effect.Effect<LoginAttempt, MailError, Imap | Secrets | MicrosoftAuth> =>
  Effect.gen(function* () {
    const obtained =
      account.auth === 'password'
        ? yield* promptPassword(
            `Mail password for ${account.email} (input hidden): `,
            prompt,
          ).pipe(
            Effect.map(
              (result): Obtained<NewLogin> =>
                result._tag === 'obtained'
                  ? { _tag: 'obtained', login: passwordLogin(result.login) }
                  : result,
            ),
          )
        : yield* signInWithDeviceCode(
            imapApp,
            `Sign in to Microsoft as ${account.email}`,
            prompt,
          ).pipe(
            Effect.map(
              (result): Obtained<NewLogin> =>
                result._tag === 'obtained'
                  ? { _tag: 'obtained', login: microsoftLogin(result.login) }
                  : result,
            ),
          );
    if (obtained._tag !== 'obtained') {
      return obtained;
    }
    const secrets = yield* Secrets;
    const imap = yield* Imap;
    yield* storeVerifiedLogin(
      account.email,
      obtained.login,
      imap.verifyLogin,
      (email, credential) => secrets.setCredential('mail', email, credential),
    );
    return stored;
  });

// Like the mail login, the password is checked against the server before it
// can replace a working one in the keyring.
const loginDav = (
  account: Account,
  prompt: HiddenPrompt,
): Effect.Effect<
  LoginAttempt,
  DavNotConfiguredError | DavRequestError | KeyringError,
  Dav | Secrets
> =>
  Effect.gen(function* () {
    const user = account.dav?.user ?? account.user;
    const obtained = yield* promptPassword(
      `Calendar and contacts password for ${account.email} (DAV user ${user}, input hidden): `,
      prompt,
    );
    if (obtained._tag !== 'obtained') {
      return obtained;
    }
    const dav = yield* Dav;
    const client = yield* dav.clientWith(account, obtained.login);
    yield* currentUserPrincipal(client);
    const secrets = yield* Secrets;
    yield* secrets.setCredential('dav', account.email, obtained.login);
    return stored;
  });

// The sign-in is checked against Microsoft Graph before its refresh token
// can replace a working one in the keyring.
const loginGraph = (
  account: Account,
  prompt: HiddenPrompt,
): Effect.Effect<
  LoginAttempt,
  GraphNotConfiguredError | OAuthError | GraphRequestError | KeyringError,
  Graph | MicrosoftAuth | Secrets
> =>
  Effect.gen(function* () {
    const settings = yield* graphSettings(account);
    const obtained = yield* signInInBrowser(
      graphApp(settings.clientId),
      account.email,
      `Sign in to Microsoft for the Outlook calendars of ${account.email}`,
      prompt,
    );
    if (obtained._tag !== 'obtained') {
      return obtained;
    }
    const graph = yield* Graph;
    yield* verifyGraph(graph.clientWith(account, obtained.login.accessToken));
    const secrets = yield* Secrets;
    yield* secrets.setCredential(
      'graph',
      account.email,
      obtained.login.refreshToken,
    );
    return stored;
  });

const logins = {
  mail: loginMail,
  dav: loginDav,
  graph: loginGraph,
} as const satisfies Record<CredentialKind, unknown>;

// Without `only`, each account logs in to mail and to the servers it
// configures: [accounts.dav] for calendars and contacts, and
// [accounts.graph] for Outlook calendars.
export const loginSteps = (
  accounts: ReadonlyArray<Account>,
  only: CredentialKind | undefined,
): ReadonlyArray<LoginStep> =>
  accounts.flatMap((account) => {
    const configured: ReadonlyArray<CredentialKind> = [
      'mail',
      ...(account.dav === undefined ? [] : (['dav'] as const)),
      ...(account.graph === undefined ? [] : (['graph'] as const)),
    ];
    return configured
      .filter((service) => only === undefined || service === only)
      .map((service) => ({ account, service }));
  });

// Logs in to each step in turn and reports every result. Resolves to true
// only when every credential was stored.
export const loginAccounts = (
  steps: ReadonlyArray<LoginStep>,
  prompt: HiddenPrompt = promptHidden,
): Effect.Effect<
  boolean,
  never,
  Imap | Secrets | MicrosoftAuth | Dav | Graph
> =>
  Effect.gen(function* () {
    const results: Array<LoginResult> = [];
    for (const { account, service } of steps) {
      const attempt: Effect.Effect<
        LoginAttempt,
        { readonly message: string },
        Imap | Secrets | MicrosoftAuth | Dav | Graph
      > = logins[service](account, prompt);
      const result = yield* attempt.pipe(
        Effect.catch((error) =>
          Effect.succeed({ _tag: 'failed', message: error.message } as const),
        ),
      );
      results.push({ email: account.email, service, ...result });
      if (result._tag === 'cancelled') {
        break;
      }
    }
    yield* Effect.forEach(
      results,
      (result) => {
        const line = `${result.email} (${result.service}): ${result.message}`;
        return result._tag === 'success'
          ? Console.log(line)
          : Console.error(line);
      },
      { discard: true },
    );
    return results.every((result) => result._tag === 'success');
  });
