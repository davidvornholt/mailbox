import { describe, expect, it } from 'bun:test';

const cliPath = Bun.fileURLToPath(new URL('./cli.ts', import.meta.url));
const fixturePath = Bun.fileURLToPath(
  new URL('../shared/accounts/accounts.fixture.toml', import.meta.url),
);

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = (
  args: ReadonlyArray<string>,
  options: { readonly config?: string; readonly stdin?: string } = {},
): CliResult => {
  const env = { ...Bun.env };
  env.PIM_CONFIG = options.config ?? fixturePath;
  const result = Bun.spawnSync(['bun', cliPath, ...args], {
    env,
    stdin: Buffer.from(options.stdin ?? ''),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const errorOf = (result: CliResult) =>
  (
    JSON.parse(result.stderr) as {
      readonly error: { readonly tag: string; readonly message: string };
    }
  ).error;

// Each case cold-starts the CLI as a subprocess, which takes several seconds
// on CI runners, well past bun test's 5s default timeout.
const subprocessTimeoutMs = 30_000;

describe('pim cli', () => {
  it(
    'prints help on stdout and exits 0',
    () => {
      const overview = runCli(['--help']);
      expect(overview.exitCode).toBe(0);
      expect(overview.stdout).toContain('mail draft save');
      const commandHelp = runCli(['mail', 'draft', 'save', '--help']);
      expect(commandHelp.exitCode).toBe(0);
      expect(commandHelp.stdout).toContain('--reply-uid <n>');
    },
    subprocessTimeoutMs,
  );

  it(
    'reports invalid arguments as JSON and exits 2',
    () => {
      const result = runCli(['mail', 'folders', '--acount', 'a@example.com']);
      expect(result.exitCode).toBe(2);
      expect(errorOf(result)).toEqual({
        tag: 'UsageError',
        message: expect.stringContaining(
          'unknown option --acount; missing --account <email>',
        ),
      });
    },
    subprocessTimeoutMs,
  );

  it(
    'lists accounts as JSON',
    () => {
      const result = runCli(['accounts']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        {
          email: 'test@example.com',
          name: 'Test Account',
          host: 'imap.test.example',
        },
      ]);
    },
    subprocessTimeoutMs,
  );

  it(
    'exits 1 when the config is missing or the account is unknown',
    () => {
      const missing = runCli(['accounts'], {
        config: '/nonexistent/accounts.toml',
      });
      expect(missing.exitCode).toBe(1);
      expect(errorOf(missing).tag).toBe('ConfigError');
      const unknown = runCli([
        'mail',
        'folders',
        '--account',
        'nobody@example.com',
      ]);
      expect(unknown.exitCode).toBe(1);
      expect(errorOf(unknown).message).toContain('test@example.com');
    },
    subprocessTimeoutMs,
  );

  it(
    'rejects invalid search and tag input before connecting',
    () => {
      const search = runCli(['mail', 'search', '--folder', 'INBOX']);
      expect(search.exitCode).toBe(2);
      expect(errorOf(search)).toEqual({
        tag: 'SearchInputError',
        message: 'Searching a folder requires an account.',
      });
      const tag = runCli([
        'mail',
        'draft',
        'tag',
        '--account=test@example.com',
        '--folder=Drafts',
        '--uid-validity=1',
        '--uid=1',
        '--keyword=\\Seen',
      ]);
      expect(tag.exitCode).toBe(2);
      expect(errorOf(tag).message).toContain('is a system flag');
    },
    subprocessTimeoutMs,
  );

  it(
    'rejects an empty draft body before connecting',
    () => {
      const result = runCli(
        [
          'mail',
          'draft',
          'save',
          '--account',
          'TEST@example.com',
          '--to',
          'x@y.z',
        ],
        { stdin: '  \n' },
      );
      expect(result.exitCode).toBe(2);
      expect(errorOf(result).message).toBe('the draft body on stdin is empty');
    },
    subprocessTimeoutMs,
  );
});

describe('pim calendar', () => {
  it(
    'rejects invalid event times before connecting',
    () => {
      const event = [
        'calendar',
        'create',
        '--account=test@example.com',
        '--calendar=Work',
        '--title=Call',
      ];
      const noEnd = runCli([...event, '--start=2026-10-28T10:00']);
      expect(noEnd.exitCode).toBe(2);
      expect(errorOf(noEnd).message).toBe(
        'pim calendar create: a timed event needs --end',
      );
      const zone = runCli([
        ...event,
        '--start=2026-10-28',
        '--time-zone=Mars/Olympus',
      ]);
      expect(zone.exitCode).toBe(2);
      expect(errorOf(zone).message).toContain('--time-zone must be');
      const update = runCli([
        'calendar',
        'update',
        '--account=test@example.com',
        '--href=/a.ics',
        '--etag=x',
      ]);
      expect(update.exitCode).toBe(2);
      expect(errorOf(update).message).toContain('pass at least one of');
      const reversed = runCli([
        'calendar',
        'update',
        '--account=test@example.com',
        '--href=/a.ics',
        '--etag=x',
        '--start=2026-10-28T10:00',
        '--end=2026-10-28T09:00',
      ]);
      expect(reversed.exitCode).toBe(2);
      expect(errorOf(reversed).message).toBe(
        'pim calendar update: --end must be after --start',
      );
    },
    subprocessTimeoutMs,
  );
});

describe('pim contacts', () => {
  it(
    'rejects invalid contacts before connecting',
    () => {
      const create = ['contacts', 'create', '--account=test@example.com'];
      const nameless = runCli([
        ...create,
        '--address-book=Contacts',
        '--email=ada@example.org',
      ]);
      expect(nameless.exitCode).toBe(2);
      expect(errorOf(nameless).message).toContain('pass at least one of');
      const phone = runCli([
        ...create,
        '--address-book=Contacts',
        '--name=Ada',
        '--phone=call me',
      ]);
      expect(phone.exitCode).toBe(2);
      expect(errorOf(phone).message).toBe(
        'pim contacts create: --phone "call me" is not a phone number of digits, spaces, and + ( ) . / -',
      );
      const update = ['contacts', 'update', '--account=test@example.com'];
      const target = ['--href=/a.vcf', '--etag=x'];
      const unchanged = runCli([...update, ...target]);
      expect(unchanged.exitCode).toBe(2);
      expect(errorOf(unchanged).message).toBe(
        'pim contacts update: pass at least one change',
      );
      const emptyName = runCli([...update, ...target, '--name=']);
      expect(emptyName.exitCode).toBe(2);
      expect(errorOf(emptyName).message).toBe(
        'pim contacts update: --name is empty',
      );
    },
    subprocessTimeoutMs,
  );
});
