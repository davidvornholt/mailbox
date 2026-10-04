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

export class ImapError extends Schema.TaggedError<ImapError>()('ImapError', {
  message: Schema.String,
}) {}

export class OAuthError extends Schema.TaggedError<OAuthError>()('OAuthError', {
  message: Schema.String,
}) {}

export class SearchInputError extends Schema.TaggedError<SearchInputError>()(
  'SearchInputError',
  {
    message: Schema.String,
  },
) {}

export class SearchAccountsError extends Schema.TaggedError<SearchAccountsError>()(
  'SearchAccountsError',
  {
    message: Schema.String,
  },
) {}

export class AccountSearchTimeoutError extends Schema.TaggedError<AccountSearchTimeoutError>()(
  'AccountSearchTimeoutError',
  {
    account: Schema.String,
    message: Schema.String,
  },
) {}

export class FolderNotFoundError extends Schema.TaggedError<FolderNotFoundError>()(
  'FolderNotFoundError',
  {
    folder: Schema.String,
    message: Schema.String,
  },
) {}

export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  'MessageNotFoundError',
  {
    folder: Schema.String,
    uid: Schema.Number,
    message: Schema.String,
  },
) {}

export class AttachmentNotFoundError extends Schema.TaggedError<AttachmentNotFoundError>()(
  'AttachmentNotFoundError',
  {
    folder: Schema.String,
    uid: Schema.Number,
    part: Schema.String,
    message: Schema.String,
  },
) {}

export class DraftError extends Schema.TaggedError<DraftError>()('DraftError', {
  message: Schema.String,
}) {}

export class StaleUidError extends Schema.TaggedError<StaleUidError>()(
  'StaleUidError',
  {
    folder: Schema.String,
    message: Schema.String,
  },
) {}

export type MailError =
  | ConfigError
  | UnknownAccountError
  | MissingCredentialsError
  | KeyringError
  | ImapError
  | OAuthError
  | SearchInputError
  | SearchAccountsError
  | AccountSearchTimeoutError
  | FolderNotFoundError
  | MessageNotFoundError
  | AttachmentNotFoundError
  | DraftError
  | StaleUidError;
