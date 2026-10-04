import { Result } from 'effect';
import { type Command, pad, UsageError } from './command-line';

// Dispatches argv to one of a program's commands or to help text.

export type Program<A> = {
  readonly name: string;
  readonly summary: string;
  readonly footer: string;
  readonly commands: ReadonlyArray<Command<A>>;
};

export type Resolution<A> =
  | { readonly _tag: 'Help'; readonly text: string }
  | { readonly _tag: 'Run'; readonly value: A }
  | { readonly _tag: 'Invalid'; readonly error: UsageError };

const isHelpFlag = (token: string): boolean =>
  token === '--help' || token === '-h';

const overview = <A>(
  program: Program<A>,
  commands: ReadonlyArray<Command<A>>,
): string =>
  [
    program.summary,
    `Usage: ${program.name} <command> [options]`,
    `Commands:\n${pad(commands.map((command) => [command.name, command.summary]))}`,
    program.footer,
  ].join('\n\n');

const matchCommand = <A>(
  commands: ReadonlyArray<Command<A>>,
  argv: ReadonlyArray<string>,
): Command<A> | undefined =>
  commands.find((command) =>
    command.name.split(' ').every((word, index) => argv[index] === word),
  );

// `help`, `--help`, and no arguments print the overview; `help <command>` and
// `<command> --help` print that command's help. A command group such as
// `draft` prints the overview of its subcommands.
export const resolve = <A>(
  program: Program<A>,
  argv: ReadonlyArray<string>,
): Resolution<A> => {
  const [first] = argv;
  if (first === undefined || first === 'help' || isHelpFlag(first)) {
    const topic = first === 'help' ? argv.slice(1) : [];
    const command = matchCommand(program.commands, topic);
    return {
      _tag: 'Help',
      text:
        command === undefined
          ? overview(program, program.commands)
          : command.help(program.name),
    };
  }
  const command = matchCommand(program.commands, argv);
  if (command === undefined) {
    const group = program.commands.filter((candidate) =>
      candidate.name.startsWith(`${first} `),
    );
    if (group.length > 0 && argv.slice(1).every(isHelpFlag)) {
      return { _tag: 'Help', text: overview(program, group) };
    }
    const attempted = group.length > 0 ? argv.slice(0, 2) : [first];
    return {
      _tag: 'Invalid',
      error: new UsageError({
        message: `unknown command "${attempted.join(' ')}"; run: ${program.name} --help`,
      }),
    };
  }
  const args = argv.slice(command.name.split(' ').length);
  if (args.some(isHelpFlag)) {
    return { _tag: 'Help', text: command.help(program.name) };
  }
  return Result.match(command.parse(args), {
    onFailure: (problems) => ({
      _tag: 'Invalid' as const,
      error: new UsageError({
        message: `${program.name} ${command.name}: ${problems.join('; ')}\n${command.usage(program.name)}`,
      }),
    }),
    onSuccess: (value) => ({ _tag: 'Run' as const, value }),
  });
};
