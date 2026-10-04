import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { MailConfig } from './config';

const fixturePath = Bun.fileURLToPath(
  new URL('./accounts.fixture.toml', import.meta.url),
);
const tempDir = `${Bun.env.TMPDIR ?? '/tmp'}/mailbox-config-test-${crypto.randomUUID()}`;
const environmentKeys = ['MAILBOX_CONFIG', 'XDG_CONFIG_HOME'] as const;
const savedEnvironment = environmentKeys.map(
  (key) => [key, Bun.env[key]] as const,
);

afterEach(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = value;
    }
  }
});

afterAll(async () => {
  await Bun.$`rm -rf ${tempDir}`;
});

const loadWith = <A, E>(effect: Effect.Effect<A, E, MailConfig>) =>
  Effect.runPromise(Effect.result(Effect.provide(effect, MailConfig.layer)));

const getAccount = (email: string) =>
  MailConfig.pipe(Effect.flatMap((config) => config.getAccount(email)));

const failureMessage = async () => {
  const result = await loadWith(MailConfig);
  if (result._tag === 'Success') {
    throw new Error('expected the config to fail');
  }
  return result.failure.message;
};

describe('MailConfig', () => {
  it('resolves an account case-insensitively to its configured spelling', async () => {
    Bun.env.MAILBOX_CONFIG = fixturePath;
    const result = await loadWith(getAccount('TEST@example.com'));
    expect(result).toMatchObject({
      _tag: 'Success',
      success: { email: 'test@example.com', host: 'imap.test.example' },
    });
  });

  it('reads accounts.toml under XDG_CONFIG_HOME when no override is set', async () => {
    Bun.env.MAILBOX_CONFIG = '';
    Bun.env.XDG_CONFIG_HOME = tempDir;
    expect(await failureMessage()).toContain(
      `No account config at ${tempDir}/mailbox/accounts.toml`,
    );
  });

  it('explains invalid TOML and schema errors with the file path', async () => {
    const invalidToml = `${tempDir}/invalid.toml`;
    const invalidSchema = `${tempDir}/schema.toml`;
    await Bun.write(invalidToml, '[[accounts]\n');
    await Bun.write(
      invalidSchema,
      '[[accounts]]\nemail = "a@b.com"\nname = "A"\nhots = "x"\n',
    );

    Bun.env.MAILBOX_CONFIG = invalidToml;
    expect(await failureMessage()).toContain('is not valid TOML');
    Bun.env.MAILBOX_CONFIG = invalidSchema;
    const schemaMessage = await failureMessage();
    expect(schemaMessage).toContain(
      `Invalid account config at ${invalidSchema}`,
    );
    expect(schemaMessage).toContain('hots');
  });
});
