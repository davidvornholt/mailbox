import { Effect } from 'effect';
import type { AttachmentContent } from '../features/mail/schemas/mail';
import { UsageError } from '../shared/command-line';
import { FileError, statPath } from './command-support';

const pathSeparators = /[/\\]/u;
const controlCharacters = /\p{Cc}/gu;
// Whitespace too: " .env" must not become the hidden file ".env".
const leadingDotsAndSpace = /^[\s.]+/u;
const trailingSlashes = /\/+$/u;

// Sender-controlled filenames must not choose the directory or create hidden
// files, so only the last path segment survives, without control characters
// or leading dots.
export const safeFilename = (filename: string | null, part: string): string => {
  const base = (filename ?? '')
    .split(pathSeparators)
    .at(-1)
    ?.replaceAll(controlCharacters, '')
    .replace(leadingDotsAndSpace, '')
    .trim();
  return base === undefined || base === '' ? `attachment-${part}` : base;
};

type PathStats = Effect.Success<ReturnType<typeof statPath>>;

const refuseExisting = (
  path: string,
  existing: PathStats,
  force: boolean,
): Effect.Effect<void, UsageError> => {
  if (existing?.isDirectory() === true) {
    return Effect.fail(
      new UsageError({
        message: `${path} is a directory; pass a different --out`,
      }),
    );
  }
  return existing !== undefined && !force
    ? Effect.fail(
        new UsageError({
          message: `${path} already exists; pass --force to overwrite it`,
        }),
      )
    : Effect.void;
};

// Refuses an existing file `out` before the download starts. A directory
// `out` is checked in writeAttachment, once the filename is known.
export const checkOut = (
  out: string,
  force: boolean,
): Effect.Effect<void, UsageError> =>
  statPath(out).pipe(
    Effect.flatMap((target) =>
      target?.isDirectory() === true
        ? Effect.void
        : refuseExisting(out, target, force),
    ),
  );

// `out` is a file path, or an existing directory to write into under the
// attachment's filename. Existing files are kept unless `force` is set.
export const writeAttachment = (
  attachment: AttachmentContent,
  out: string,
  force: boolean,
): Effect.Effect<string, UsageError | FileError> =>
  Effect.gen(function* () {
    const target = yield* statPath(out);
    const path =
      target?.isDirectory() === true
        ? `${out.replace(trailingSlashes, '')}/${safeFilename(attachment.filename, attachment.part)}`
        : out;
    yield* refuseExisting(
      path,
      path === out ? target : yield* statPath(path),
      force,
    );
    yield* Effect.tryPromise({
      try: () => Bun.write(path, attachment.content),
      catch: (cause) =>
        new FileError({ message: `could not write ${path}: ${String(cause)}` }),
    });
    return path;
  });
