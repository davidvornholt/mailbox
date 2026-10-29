import { Schema } from 'effect';

export class DavNotConfiguredError extends Schema.TaggedError<DavNotConfiguredError>()(
  'DavNotConfiguredError',
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
  // The request may have reached the server, and nothing tells whether the
  // server applied it: the connection failed or timed out, or the server
  // failed (HTTP 5xx).
  uncertain: Schema.optionalKey(Schema.Boolean),
}) {}

export type DavRequestError =
  | DavAuthError
  | DavNotFoundError
  | DavConflictError
  | DavError;
