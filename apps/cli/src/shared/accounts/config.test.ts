import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { AccountConfig } from './config';

const fixturePath = Bun.fileURLToPath(
  new URL('./accounts.fixture.toml', import.meta.url),
);
const tempDir = `${Bun.env.TMPDIR ?? '/tmp'}/pim-config-test-${crypto.randomUUID()}`;
const environmentKeys = ['PIM_CONFIG', 'XDG_CONFIG_HOME'] as const;
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

const loadWith = <A, E>(effect: Effect.Effect<A, E, AccountConfig>) =>
  Effect.runPromise(Effect.result(Effect.provide(effect, AccountConfig.layer)));

const getAccount = (email: string) =>
  AccountConfig.pipe(Effect.flatMap((config) => config.getAccount(email)));

const failureMessage = async () => {
  const result = await loadWith(AccountConfig);
  if (result._tag === 'Success') {
    throw new Error('expected the config to fail');
  }
  return result.failure.message;
};

describe('AccountConfig', () => {
  it('resolves an account case-insensitively to its configured spelling', async () => {
    Bun.env.PIM_CONFIG = fixturePath;
    const result = await loadWith(getAccount('TEST@example.com'));
    expect(result).toMatchObject({
      _tag: 'Success',
      success: {
        email: 'test@example.com',
        mail: { host: 'imap.test.example' },
      },
    });
  });

  it('accepts the example config', async () => {
    Bun.env.PIM_CONFIG = Bun.fileURLToPath(
      new URL('../../../accounts.example.toml', import.meta.url),
    );
    expect(await loadWith(getAccount('you@outlook.com'))).toMatchObject({
      _tag: 'Success',
      success: { mail: { auth: 'microsoft' }, graph: {} },
    });
  });

  it('reads accounts.toml under XDG_CONFIG_HOME when no override is set', async () => {
    Bun.env.PIM_CONFIG = '';
    Bun.env.XDG_CONFIG_HOME = tempDir;
    expect(await failureMessage()).toContain(
      `No account config at ${tempDir}/pim/accounts.toml`,
    );
  });

  it('reads a graph sub-table with its client-id', async () => {
    const path = `${tempDir}/graph.toml`;
    await Bun.write(
      path,
      '[accounts."a@example.com"]\nname = "A"\n\n[accounts."a@example.com".graph]\nclient-id = "00000000-0000-4000-8000-000000000003"\n',
    );
    Bun.env.PIM_CONFIG = path;
    expect(await loadWith(getAccount('a@example.com'))).toMatchObject({
      _tag: 'Success',
      success: { graph: { clientId: '00000000-0000-4000-8000-000000000003' } },
    });
  });

  it('explains invalid TOML and schema errors with the file path', async () => {
    const invalidToml = `${tempDir}/invalid.toml`;
    const invalidSchema = `${tempDir}/schema.toml`;
    await Bun.write(invalidToml, '[accounts."a@b.com"\n');
    await Bun.write(
      invalidSchema,
      '[accounts."a@b.com"]\nname = "A"\nmail = { hots = "x" }\n',
    );

    Bun.env.PIM_CONFIG = invalidToml;
    expect(await failureMessage()).toContain('is not valid TOML');
    Bun.env.PIM_CONFIG = invalidSchema;
    const schemaMessage = await failureMessage();
    expect(schemaMessage).toContain(
      `Invalid account config at ${invalidSchema}`,
    );
    expect(schemaMessage).toContain('hots');
  });
});
