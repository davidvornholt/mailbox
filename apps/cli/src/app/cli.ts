import process from 'node:process';
import { Effect } from 'effect';
import { resolve } from '../shared/command-program';
import type { CommandEffect, Outcome } from './command-support';
import { program } from './commands';
import { appLayer } from './runtime';

const failureExitCode = 1;
const usageExitCode = 2;
// Errors about the arguments themselves, as opposed to mail or config state.
const invalidInputTags = new Set(['UsageError', 'SearchInputError']);

// Pretty-print for people at a terminal; keep piped output compact for agents.
const writeJson = (stream: NodeJS.WriteStream, value: unknown): void => {
  stream.write(
    `${JSON.stringify(value, null, stream.isTTY === true ? 2 : undefined)}\n`,
  );
};

const report = (error: {
  readonly _tag: string;
  readonly message: string;
}): Effect.Effect<void> =>
  Effect.sync(() => {
    writeJson(process.stderr, {
      error: { tag: error._tag, message: error.message },
    });
    process.exitCode = invalidInputTags.has(error._tag)
      ? usageExitCode
      : failureExitCode;
  });

const emit = (outcome: Outcome): Effect.Effect<void> =>
  Effect.sync(() => {
    if (outcome._tag === 'Json') {
      writeJson(process.stdout, outcome.value);
    }
    if (outcome.failed) {
      process.exitCode = failureExitCode;
    }
  });

// Providing the layer inside the handled effect means a config that fails to
// load is reported like any other command error.
const execute = (command: CommandEffect): Effect.Effect<void> =>
  command.pipe(
    Effect.provide(appLayer),
    Effect.flatMap(emit),
    Effect.catch(report),
    Effect.catchDefect((defect) =>
      report({ _tag: 'UnexpectedError', message: String(defect) }),
    ),
  );

const resolution = resolve(program, Bun.argv.slice(2));
if (resolution._tag === 'Help') {
  process.stdout.write(`${resolution.text}\n`);
} else if (resolution._tag === 'Invalid') {
  await Effect.runPromise(report(resolution.error));
} else {
  await Effect.runPromise(execute(resolution.value));
}
