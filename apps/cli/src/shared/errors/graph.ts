import { Schema } from 'effect';

export class GraphNotConfiguredError extends Schema.TaggedError<GraphNotConfiguredError>()(
  'GraphNotConfiguredError',
  {
    message: Schema.String,
  },
) {}

// Microsoft Graph rejected the access token (HTTP 401).
export class GraphAuthError extends Schema.TaggedError<GraphAuthError>()(
  'GraphAuthError',
  {
    account: Schema.String,
    message: Schema.String,
  },
) {}

// The account may not read the resource (HTTP 403).
export class GraphAccessError extends Schema.TaggedError<GraphAccessError>()(
  'GraphAccessError',
  {
    account: Schema.String,
    message: Schema.String,
  },
) {}

export class GraphNotFoundError extends Schema.TaggedError<GraphNotFoundError>()(
  'GraphNotFoundError',
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

// Microsoft Graph limits the requests of the account or of pim (HTTP 429).
export class GraphThrottledError extends Schema.TaggedError<GraphThrottledError>()(
  'GraphThrottledError',
  {
    account: Schema.String,
    retryAfterSeconds: Schema.optionalKey(Schema.Number),
    message: Schema.String,
  },
) {}

// The event changed since the caller read it (HTTP 412, or another etag
// than the one the caller passed).
export class GraphConflictError extends Schema.TaggedError<GraphConflictError>()(
  'GraphConflictError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

// Any other failure: the request did not reach Microsoft Graph, timed out,
// or got an error or an unexpected answer.
export class GraphError extends Schema.TaggedError<GraphError>()('GraphError', {
  message: Schema.String,
}) {}

export type GraphRequestError =
  | GraphAuthError
  | GraphAccessError
  | GraphNotFoundError
  | GraphThrottledError
  | GraphConflictError
  | GraphError;
