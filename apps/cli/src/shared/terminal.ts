import process from 'node:process';
import { Effect } from 'effect';

const ENTER = new Set(['\n', '\r', '\u0004']);
const BACKSPACE = new Set(['\u007f', '\b']);
const CTRL_C = '\u0003';

export type HiddenPromptResult =
  | { readonly _tag: 'entered'; readonly value: string }
  | { readonly _tag: 'cancelled' };

// Read a line from the terminal with echo disabled, so a typed password never
// appears on screen, in shell history, or in an agent transcript. A missing TTY
// is an intentionally empty input; Ctrl-C is a distinct cancellation.
export const promptHidden = (
  question: string,
): Effect.Effect<HiddenPromptResult> =>
  Effect.callback<HiddenPromptResult>((resume) => {
    const input = process.stdin;
    if (input.isTTY !== true) {
      resume(Effect.succeed({ _tag: 'entered', value: '' } as const));
      return;
    }
    process.stdout.write(question);
    const previousRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const restore = (): void => {
      input.setRawMode(previousRaw);
      input.pause();
      input.removeAllListeners('data');
      process.stdout.write('\n');
    };
    const stop = (result: HiddenPromptResult): void => {
      restore();
      resume(Effect.succeed(result));
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === CTRL_C) {
          stop({ _tag: 'cancelled' });
          return;
        }
        if (ENTER.has(char)) {
          stop({ _tag: 'entered', value });
          return;
        }
        value = BACKSPACE.has(char) ? value.slice(0, -1) : value + char;
      }
    };
    input.on('data', onData);
    // Restores the terminal when the prompt is interrupted, as when it loses a
    // race.
    return Effect.sync(restore);
  });

export const stdinIsTerminal = (): boolean => process.stdin.isTTY === true;

export const stdoutIsTerminal = (): boolean => process.stdout.isTTY === true;

// Reads all of piped stdin. Returns undefined for an interactive terminal so
// callers fail fast instead of waiting for input nobody will type.
export const readPipedStdin: Effect.Effect<string | undefined> = Effect.suspend(
  () =>
    stdinIsTerminal()
      ? Effect.succeed(undefined)
      : Effect.promise(() => Bun.stdin.text()),
);
