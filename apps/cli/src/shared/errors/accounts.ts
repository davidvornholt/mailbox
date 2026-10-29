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

// A Microsoft sign-in failed or Microsoft rejected the stored one.
export class OAuthError extends Schema.TaggedError<OAuthError>()('OAuthError', {
  message: Schema.String,
}) {}

// Raised when a command across several accounts fails for every one of them.
export class AccountsError extends Schema.TaggedError<AccountsError>()(
  'AccountsError',
  {
    message: Schema.String,
  },
) {}
