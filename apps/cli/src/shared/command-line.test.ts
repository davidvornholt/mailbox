import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import { defineCommand, flag } from './command-line';

const show = defineCommand(
  {
    name: 'show',
    summary: 'Show a message',
    flags: {
      account: flag.text('email', 'Account'),
      uid: flag.integer('n', 'Message uid'),
      limit: flag.optionalInteger('n', 'Maximum'),
      html: flag.switch('Include HTML'),
    },
  },
  (values) => values,
);
const tag = defineCommand(
  {
    name: 'draft tag',
    summary: 'Tag drafts',
    flags: {
      uid: flag.integers('n', 'Draft uid'),
      attach: flag.texts('path', 'File'),
    },
  },
  (values) => values,
);
const problems = (args: ReadonlyArray<string>) =>
  Result.match(show.parse(args), {
    onFailure: (found) => found,
    onSuccess: () => [],
  });

describe('defineCommand parse', () => {
  it('reads kebab-case options in both value forms', () => {
    expect(show.parse(['--account=a@b.c', '--uid', '7', '--html'])).toEqual(
      Result.succeed({
        account: 'a@b.c',
        uid: 7,
        limit: undefined,
        html: true,
      }),
    );
  });

  it('collects repeated values for list flags', () => {
    expect(tag.parse(['--uid', '1', '--uid=2'])).toEqual(
      Result.succeed({ uid: [1, 2], attach: [] }),
    );
    expect(tag.parse([])).toEqual(Result.fail(['missing --uid <n>']));
  });

  it('reports every problem at once', () => {
    expect(
      problems(['stray', '--acount', 'x', '--uid', '0', '--html=yes']),
    ).toEqual([
      'unexpected argument "stray"; every value needs its option name',
      'unknown option --acount',
      '--html takes no value',
      'missing --account <email>',
      '--uid must be a positive integer, not "0"',
    ]);
  });

  it('reports a missing value once, not also as a missing option', () => {
    expect(problems(['--account', '--uid'])).toEqual([
      '--account needs a value <email>',
      '--uid needs a value <n>',
    ]);
  });

  it('rejects repeats, blanks, and unsafe integers', () => {
    expect(problems(['--account', ' ', '--uid', '1', '--uid', '2'])).toEqual([
      '--account must not be empty',
      '--uid was given more than once',
    ]);
    expect(
      problems(['--account', 'a', '--uid', '1', '--limit', '9007199254740993']),
    ).toEqual(['--limit must be a positive integer, not "9007199254740993"']);
  });
});
