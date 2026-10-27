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

const words = <A>(command: Command<A>): ReadonlyArray<string> =>
  command.name.split(' ');

const startsWith = (
  name: ReadonlyArray<string>,
  prefix: ReadonlyArray<string>,
): boolean => prefix.every((word, index) => name[index] === word);

const matchCommand = <A>(
  commands: ReadonlyArray<Command<A>>,
  argv: ReadonlyArray<string>,
): Command<A> | undefined =>
  commands.find((command) => startsWith(argv, words(command)));

// The longest argv prefix that names a command group, such as `mail` or
// `mail draft`; empty when argv does not start with a group.
const groupPrefix = <A>(
  commands: ReadonlyArray<Command<A>>,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const isGroup = (prefix: ReadonlyArray<string>) =>
    commands.some((command) => {
      const name = words(command);
      return name.length > prefix.length && startsWith(name, prefix);
    });
  const end = argv.findIndex((_, index) => !isGroup(argv.slice(0, index + 1)));
  return argv.slice(0, end === -1 ? argv.length : end);
};

const groupCommands = <A>(
  commands: ReadonlyArray<Command<A>>,
  prefix: ReadonlyArray<string>,
): ReadonlyArray<Command<A>> =>
  commands.filter((command) => startsWith(words(command), prefix));

const helpText = <A>(
  program: Program<A>,
  topic: ReadonlyArray<string>,
): string => {
  const command = matchCommand(program.commands, topic);
  return command === undefined
    ? overview(
        program,
        groupCommands(program.commands, groupPrefix(program.commands, topic)),
      )
    : command.help(program.name);
};

// `help`, `--help`, and no arguments print the overview; `help <command>` and
// `<command> --help` print that command's help. A command group such as
// `mail` or `mail draft` prints the overview of its subcommands.
export const resolve = <A>(
  program: Program<A>,
  argv: ReadonlyArray<string>,
): Resolution<A> => {
  const [first] = argv;
  if (first === undefined || first === 'help' || isHelpFlag(first)) {
    const topic = first === 'help' ? argv.slice(1) : [];
    return { _tag: 'Help', text: helpText(program, topic) };
  }
  const command = matchCommand(program.commands, argv);
  if (command === undefined) {
    const prefix = groupPrefix(program.commands, argv);
    if (prefix.length > 0 && argv.slice(prefix.length).every(isHelpFlag)) {
      return { _tag: 'Help', text: helpText(program, prefix) };
    }
    return {
      _tag: 'Invalid',
      error: new UsageError({
        message: `unknown command "${argv.slice(0, prefix.length + 1).join(' ')}"; run: ${program.name} --help`,
      }),
    };
  }
  const args = argv.slice(words(command).length);
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
