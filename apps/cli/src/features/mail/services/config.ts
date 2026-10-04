import { Context, Effect, Layer, Result } from 'effect';
import { ConfigError, UnknownAccountError } from '../errors/errors';
import { type Account, decodeAccounts, findAccount } from '../schemas/account';

// MAILBOX_CONFIG overrides the XDG location (tests point it at fixtures).
const resolveConfigPath = (): Effect.Effect<string, ConfigError> => {
  const override = Bun.env.MAILBOX_CONFIG;
  if (override !== undefined && override !== '') {
    return Effect.succeed(override);
  }
  const configHome =
    Bun.env.XDG_CONFIG_HOME ||
    (Bun.env.HOME === undefined ? undefined : `${Bun.env.HOME}/.config`);
  return configHome === undefined
    ? Effect.fail(
        new ConfigError({
          message:
            'Cannot locate the account config: set MAILBOX_CONFIG, XDG_CONFIG_HOME, or HOME.',
        }),
      )
    : Effect.succeed(`${configHome}/mailbox/accounts.toml`);
};

const missingConfigMessage = (path: string): string =>
  `No account config at ${path}. Create it with one [[accounts]] block per account containing email, name, and host (port defaults to 993, secure to true, user to the email), then run: mailbox login`;

const loadAccounts = Effect.gen(function* () {
  const path = yield* resolveConfigPath();
  const file = Bun.file(path);
  const exists = yield* Effect.promise(() => file.exists());
  if (!exists) {
    return yield* Effect.fail(
      new ConfigError({ message: missingConfigMessage(path) }),
    );
  }
  const text = yield* Effect.tryPromise({
    try: () => file.text(),
    catch: (cause) =>
      new ConfigError({
        message: `Could not read the account config at ${path}: ${String(cause)}`,
      }),
  });
  const parsed = yield* Effect.try({
    try: (): unknown => Bun.TOML.parse(text),
    catch: (cause) =>
      new ConfigError({
        message: `The account config at ${path} is not valid TOML: ${String(cause)}`,
      }),
  });
  return yield* Result.match(decodeAccounts(parsed), {
    onFailure: (details) =>
      Effect.fail(
        new ConfigError({
          message: `Invalid account config at ${path}:\n${details}`,
        }),
      ),
    onSuccess: (accounts) => Effect.succeed(accounts),
  });
});

export class MailConfig extends Context.Service<
  MailConfig,
  {
    readonly accounts: ReadonlyArray<Account>;
    readonly emails: ReadonlyArray<string>;
    // Matches case-insensitively and returns the configured spelling.
    readonly getAccount: (
      email: string,
    ) => Effect.Effect<Account, UnknownAccountError>;
  }
>()('mail/MailConfig') {
  static readonly layer = Layer.effect(
    MailConfig,
    Effect.gen(function* () {
      const accounts = yield* loadAccounts;
      const emails = accounts.map((account) => account.email);
      return MailConfig.of({
        accounts,
        emails,
        getAccount: (email) => {
          const account = findAccount(accounts, email);
          return account === undefined
            ? Effect.fail(
                new UnknownAccountError({
                  email,
                  message: `Unknown account "${email}". Configured accounts: ${emails.join(', ')}`,
                }),
              )
            : Effect.succeed(account);
        },
      });
    }),
  );
}
