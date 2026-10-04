import { Result, Schema } from 'effect';

// A small declarative command-line layer: long options only, no positional
// arguments, so every value an agent passes is named. Options are declared in
// camelCase and written in kebab-case (`uidValidity` is `--uid-validity`).

export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  message: Schema.String,
}) {}

type ValueFlag<Kind extends string, Required extends boolean> = {
  readonly kind: Kind;
  readonly required: Required;
  readonly placeholder: string;
  readonly description: string;
};

type SwitchFlag = {
  readonly kind: 'switch';
  readonly required: false;
  readonly description: string;
};

type Flag =
  | ValueFlag<'text' | 'integer' | 'texts' | 'integers', boolean>
  | SwitchFlag;

type Flags = Readonly<Record<string, Flag>>;

type FlagValue<F extends Flag> = F extends SwitchFlag
  ? boolean
  : F extends ValueFlag<'texts', boolean>
    ? ReadonlyArray<string>
    : F extends ValueFlag<'integers', boolean>
      ? ReadonlyArray<number>
      : F extends ValueFlag<'integer', true>
        ? number
        : F extends ValueFlag<'integer', false>
          ? number | undefined
          : F extends ValueFlag<'text', true>
            ? string
            : string | undefined;

export type FlagValues<F extends Flags> = {
  readonly [Key in keyof F]: FlagValue<F[Key]>;
};

const valueFlag =
  <Kind extends ValueFlag<string, boolean>['kind'], Required extends boolean>(
    kind: Kind,
    required: Required,
  ) =>
  (placeholder: string, description: string): ValueFlag<Kind, Required> => ({
    kind,
    required,
    placeholder,
    description,
  });

// Lists repeat the option once per value; required lists need at least one.
export const flag = {
  text: valueFlag('text', true),
  optionalText: valueFlag('text', false),
  integer: valueFlag('integer', true),
  optionalInteger: valueFlag('integer', false),
  texts: valueFlag('texts', false),
  integers: valueFlag('integers', true),
  switch: (description: string): SwitchFlag => ({
    kind: 'switch',
    required: false,
    description,
  }),
} as const;

const optionName = (key: string): string =>
  `--${key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;

const optionSyntax = (key: string, spec: Flag): string =>
  spec.kind === 'switch'
    ? optionName(key)
    : `${optionName(key)} <${spec.placeholder}>`;

const usageTerm = (key: string, spec: Flag): string => {
  const syntax = optionSyntax(key, spec);
  const repeated =
    spec.kind === 'texts' || spec.kind === 'integers' ? `${syntax}...` : syntax;
  return spec.required ? repeated : `[${repeated}]`;
};

const positiveInteger = /^[1-9]\d*$/u;

type Collected = {
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>;
  // Keys given without a value, already reported as problems.
  readonly valueless: ReadonlySet<string>;
};

type Collector = {
  readonly args: ReadonlyArray<string>;
  readonly flags: Flags;
  readonly keysByOption: ReadonlyMap<string, string>;
  readonly values: Map<string, Array<string>>;
  readonly valueless: Set<string>;
  readonly problems: Array<string>;
};

// The token at `position` when it can be an option's value.
const valueAt = (
  args: ReadonlyArray<string>,
  position: number,
): string | undefined => {
  const token = args[position];
  return token === undefined || token.startsWith('--') ? undefined : token;
};

type Token = {
  readonly raw: string;
  readonly option: string;
  // The value after `=`, if the token has one.
  readonly inline: string | undefined;
};

const splitToken = (raw: string): Token => {
  const separator = raw.indexOf('=');
  return separator === -1
    ? { raw, option: raw, inline: undefined }
    : {
        raw,
        option: raw.slice(0, separator),
        inline: raw.slice(separator + 1),
      };
};

// An unknown option also consumes a following value so one typo yields one
// problem. Returns the position of the next token.
const readUnknown = (
  collector: Collector,
  position: number,
  token: Token,
): number => {
  if (!token.raw.startsWith('--')) {
    collector.problems.push(
      `unexpected argument "${token.raw}"; every value needs its option name`,
    );
    return position + 1;
  }
  collector.problems.push(`unknown option ${token.option}`);
  const takesNext =
    token.inline === undefined &&
    valueAt(collector.args, position + 1) !== undefined;
  return takesNext ? position + 2 : position + 1;
};

// Reads the option at `position` and returns the position of the next token.
const readOption = (collector: Collector, position: number): number => {
  const token = splitToken(collector.args[position] ?? '');
  const { option, inline } = token;
  const key = collector.keysByOption.get(option);
  const spec = key === undefined ? undefined : collector.flags[key];
  if (key === undefined || spec === undefined) {
    return readUnknown(collector, position, token);
  }
  if (spec.kind === 'switch') {
    if (inline !== undefined) {
      collector.problems.push(`${option} takes no value`);
    }
    collector.values.set(key, ['']);
    return position + 1;
  }
  const value = inline ?? valueAt(collector.args, position + 1);
  if (value === undefined) {
    collector.problems.push(`${option} needs a value <${spec.placeholder}>`);
    collector.valueless.add(key);
    return position + 1;
  }
  collector.values.set(key, [...(collector.values.get(key) ?? []), value]);
  return inline === undefined ? position + 2 : position + 1;
};

// Groups raw values by flag key.
const collect = (
  args: ReadonlyArray<string>,
  flags: Flags,
  problems: Array<string>,
): Collected => {
  const collector: Collector = {
    args,
    flags,
    keysByOption: new Map(
      Object.keys(flags).map((key) => [optionName(key), key]),
    ),
    values: new Map(),
    valueless: new Set(),
    problems,
  };
  let position = 0;
  while (position < args.length) {
    position = readOption(collector, position);
  }
  return { values: collector.values, valueless: collector.valueless };
};

const toInteger = (
  option: string,
  raw: string,
  problems: Array<string>,
): number => {
  if (!(positiveInteger.test(raw) && Number.isSafeInteger(Number(raw)))) {
    problems.push(`${option} must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
};

const valueFor = (
  key: string,
  spec: Flag,
  collected: Collected,
  problems: Array<string>,
): unknown => {
  const option = optionName(key);
  const raw = collected.values.get(key) ?? [];
  if (spec.kind === 'switch') {
    return raw.length > 0;
  }
  if (spec.required && raw.length === 0 && !collected.valueless.has(key)) {
    problems.push(`missing ${optionSyntax(key, spec)}`);
  }
  if (spec.kind === 'texts') {
    return raw;
  }
  if (spec.kind === 'integers') {
    return raw.map((entry) => toInteger(option, entry, problems));
  }
  if (raw.length > 1) {
    problems.push(`${option} was given more than once`);
  }
  const [value] = raw;
  if (value === undefined) {
    return;
  }
  if (spec.kind === 'integer') {
    return toInteger(option, value, problems);
  }
  if (spec.required && value.trim() === '') {
    problems.push(`${option} must not be empty`);
  }
  return value;
};

export type CommandSpec<F extends Flags> = {
  // Space-separated words after the program name, such as "draft save".
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  readonly flags: F;
};

export type Command<A> = {
  readonly name: string;
  readonly summary: string;
  readonly usage: (program: string) => string;
  readonly help: (program: string) => string;
  readonly parse: (
    args: ReadonlyArray<string>,
  ) => Result.Result<A, ReadonlyArray<string>>;
};

export const pad = (rows: ReadonlyArray<readonly [string, string]>): string => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows
    .map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
    .join('\n');
};

export const defineCommand = <const F extends Flags, A>(
  spec: CommandSpec<F>,
  build: (values: FlagValues<F>) => A,
): Command<A> => {
  const entries = Object.entries(spec.flags);
  const usage = (program: string): string =>
    [
      `Usage: ${program} ${spec.name}`,
      ...entries.map(([key, flagSpec]) => usageTerm(key, flagSpec)),
    ].join(' ');
  return {
    name: spec.name,
    summary: spec.summary,
    usage,
    help: (program) =>
      [
        usage(program),
        spec.description ?? spec.summary,
        entries.length === 0
          ? undefined
          : `Options:\n${pad(
              entries.map(([key, flagSpec]) => [
                optionSyntax(key, flagSpec),
                flagSpec.description,
              ]),
            )}`,
      ]
        .filter((section) => section !== undefined)
        .join('\n\n'),
    parse: (args) => {
      const problems: Array<string> = [];
      const collected = collect(args, spec.flags, problems);
      const values = Object.fromEntries(
        entries.map(([key, flagSpec]) => [
          key,
          valueFor(key, flagSpec, collected, problems),
        ]),
      );
      // valueFor produces each value from the same spec that types
      // FlagValues<F>, so the assembled record has that shape.
      return problems.length === 0
        ? Result.succeed(build(values as FlagValues<F>))
        : Result.fail(problems);
    },
  };
};
