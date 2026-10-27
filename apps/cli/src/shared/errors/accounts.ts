import { Schema } from 'effect';

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  'ConfigError',
  {
    message: Schema.String,
  },
) {}

export class UnknownAccountError extends Schema.TaggedError<UnknownAccountError>()(
  'UnknownAccountError',
  {
    email: Schema.String,
    message: Schema.String,
  },
) {}

export class MissingCredentialsError extends Schema.TaggedError<MissingCredentialsError>()(
  'MissingCredentialsError',
  {
    account: Schema.String,
    message: Schema.String,
  },
) {}

export class KeyringError extends Schema.TaggedError<KeyringError>()(
  'KeyringError',
  {
    message: Schema.String,
  },
) {}
