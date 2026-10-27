import { describe, expect, it } from 'bun:test';
import { defineCommand, flag } from './command-line';
import { type Program, resolve } from './command-program';

const show = defineCommand(
  {
    name: 'show',
    summary: 'Show a message',
    flags: { account: flag.text('email', 'Account') },
  },
  (values) => values,
);
const tag = defineCommand(
  {
    name: 'mail draft tag',
    summary: 'Tag drafts',
    flags: { uid: flag.integers('n', 'Draft uid') },
  },
  (values) => values,
);
const read = defineCommand(
  { name: 'mail read', summary: 'Read a message', flags: {} },
  (values) => values,
);
const program: Program<unknown> = {
  name: 'tool',
  summary: 'tool: test program',
  footer: 'Footer text',
  commands: [show, tag, read],
};

describe('resolve', () => {
  it.each([[[]], [['help']], [['--help']], [['-h']]])(
    'prints the overview for %p',
    (argv) => {
      const resolution = resolve(program, argv);
      expect(resolution).toMatchObject({ _tag: 'Help' });
      expect(resolution._tag === 'Help' && resolution.text).toContain(
        'Footer text',
      );
    },
  );

  it('prints command help for "help <command>" and "<command> --help"', () => {
    const expected = { _tag: 'Help' as const, text: tag.help('tool') };
    expect(resolve(program, ['help', 'mail', 'draft', 'tag'])).toEqual(
      expected,
    );
    expect(resolve(program, ['mail', 'draft', 'tag', '--help'])).toEqual(
      expected,
    );
  });

  const helpOf = (argv: ReadonlyArray<string>): string => {
    const resolution = resolve(program, argv);
    return resolution._tag === 'Help' ? resolution.text : '';
  };

  it.each([[['mail']], [['mail', '--help']], [['help', 'mail']]])(
    'prints a group overview for %p',
    (argv) => {
      const text = helpOf(argv);
      expect(text).toContain('mail draft tag');
      expect(text).toContain('mail read');
      expect(text).not.toContain('show');
    },
  );

  it.each([
    [['mail', 'draft']],
    [['mail', 'draft', '-h']],
    [['help', 'mail', 'draft']],
  ])('prints a nested group overview for %p', (argv) => {
    const text = helpOf(argv);
    expect(text).toContain('mail draft tag');
    expect(text).not.toContain('mail read');
  });

  it('rejects unknown commands and invalid arguments with usage', () => {
    expect(resolve(program, ['mail', 'draft', 'send'])).toMatchObject({
      _tag: 'Invalid',
      error: {
        message: 'unknown command "mail draft send"; run: tool --help',
      },
    });
    expect(resolve(program, ['mail', 'send', '--help'])).toMatchObject({
      _tag: 'Invalid',
      error: { message: 'unknown command "mail send"; run: tool --help' },
    });
    expect(resolve(program, ['send'])).toMatchObject({
      _tag: 'Invalid',
      error: { message: 'unknown command "send"; run: tool --help' },
    });
    expect(resolve(program, ['show'])).toMatchObject({
      _tag: 'Invalid',
      error: {
        _tag: 'UsageError',
        message: `tool show: missing --account <email>\n${show.usage('tool')}`,
      },
    });
  });

  it('runs a command with parsed values', () => {
    const uid = 3;
    expect(
      resolve(program, ['mail', 'draft', 'tag', '--uid', String(uid)]),
    ).toEqual({
      _tag: 'Run',
      value: { uid: [uid] },
    });
  });
});
