import { Schema } from 'effect';

export class DavNotConfiguredError extends Schema.TaggedError<DavNotConfiguredError>()(
  'DavNotConfiguredError',
  {
    message: Schema.String,
  },
) {}

// Raised when a command across all DAV accounts fails for every one of them.
export class DavAccountsError extends Schema.TaggedError<DavAccountsError>()(
  'DavAccountsError',
  {
    message: Schema.String,
  },
) {}

export class DavAuthError extends Schema.TaggedError<DavAuthError>()(
  'DavAuthError',
  {
    account: Schema.String,
    message: Schema.String,
  },
) {}

export class DavNotFoundError extends Schema.TaggedError<DavNotFoundError>()(
  'DavNotFoundError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

// The resource changed since it was read, so a change based on that version
// was refused.
export class DavConflictError extends Schema.TaggedError<DavConflictError>()(
  'DavConflictError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

export class DavError extends Schema.TaggedError<DavError>()('DavError', {
  message: Schema.String,
}) {}

export type DavRequestError =
  | DavAuthError
  | DavNotFoundError
  | DavConflictError
  | DavError;
