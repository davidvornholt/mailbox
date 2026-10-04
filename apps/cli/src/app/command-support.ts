import { Effect, Schema } from 'effect';
import type { MailError } from '../features/mail/errors/errors';
import { MailConfig } from '../features/mail/services/config';
import type { Imap } from '../features/mail/services/imap';
import type { MicrosoftAuth } from '../features/mail/services/microsoft-auth';
import type { Secrets } from '../features/mail/services/secrets';
import type { UsageError } from '../shared/command-line';

export class FileError extends Schema.TaggedError<FileError>()('FileError', {
  message: Schema.String,
}) {}

// A command either returns JSON for stdout or has already written its own
// output. `failed` exits 1 without an error, as when an account is not ready.
export type Outcome =
  | { readonly _tag: 'Json'; readonly value: unknown; readonly failed: boolean }
  | { readonly _tag: 'Printed'; readonly failed: boolean };

export const json = (value: unknown, failed = false): Outcome => ({
  _tag: 'Json',
  value,
  failed,
});

export const printed = (failed: boolean): Outcome => ({
  _tag: 'Printed',
  failed,
});

export type CommandError = MailError | UsageError | FileError;

export type CommandEffect = Effect.Effect<
  Outcome,
  CommandError,
  MailConfig | Secrets | MicrosoftAuth | Imap
>;

// Accounts match case-insensitively; services and the keyring use the
// configured spelling.
export const configuredEmail = (email: string) =>
  MailConfig.pipe(
    Effect.flatMap((config) => config.getAccount(email)),
    Effect.map((account) => account.email),
  );

// Resolves to undefined when the path does not exist.
export const statPath = (path: string) =>
  Effect.promise(() =>
    Bun.file(path)
      .stat()
      .catch(() => undefined),
  );
