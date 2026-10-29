import { Duration, Effect, Schema } from 'effect';
import { loginCommand } from '../accounts/secrets';
import {
  GraphAccessError,
  GraphAuthError,
  GraphConflictError,
  GraphError,
  GraphNotFoundError,
  type GraphRequestError,
  GraphThrottledError,
} from '../errors/graph';

const graphRoot = 'https://graph.microsoft.com/v1.0';
const requestTimeoutSeconds = 30;
// Guards against a server that never stops sending next page links.
const maxPages = 100;
const unauthorized = 401;
const forbidden = 403;
const notFound = 404;
const preconditionFailed = 412;
const tooManyRequests = 429;
const wholeSeconds = /^\d+$/u;

// Sends a request. Injected so tests run without the network.
export type GraphFetch = (
  url: string,
  init: {
    readonly method: GraphMethod;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export type GraphMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// A request that changes something, such as an event.
export type GraphWrite = {
  readonly method: Exclude<GraphMethod, 'GET'>;
  readonly path: string;
  // Sent as JSON.
  readonly body?: unknown;
  // The etag the resource must still have. Microsoft Graph honors it on a
  // PATCH of an event but ignores it on a DELETE.
  readonly ifMatch?: string;
};

// Preferences such as outlook.timezone="UTC" for the Prefer header.
export type GraphOptions = { readonly prefer?: ReadonlyArray<string> };

export type GraphClient = {
  readonly account: string;
  // One resource, from a path such as /me/calendars?$top=1.
  readonly get: <A>(
    path: string,
    schema: Schema.Decoder<A>,
    options?: GraphOptions,
  ) => Effect.Effect<A, GraphRequestError>;
  // The items of a collection, from every page.
  readonly list: (
    path: string,
    options?: GraphOptions,
  ) => Effect.Effect<ReadonlyArray<unknown>, GraphRequestError>;
  // Sends the write once, and decodes the answer with schema. An answer
  // without a body decodes as undefined.
  readonly send: <A>(
    write: GraphWrite,
    schema: Schema.Decoder<A>,
    options?: GraphOptions,
  ) => Effect.Effect<A, GraphRequestError>;
};

const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
});

const Page = Schema.Struct({
  value: Schema.Array(Schema.Unknown),
  nextLink: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ nextLink: '@odata.nextLink' }));

type Answer = {
  readonly ok: boolean;
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: unknown;
};

// The error code and message Microsoft Graph sent, for the error message.
const errorDetail = (body: unknown): string => {
  const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
  if (decoded._tag === 'None') {
    return '';
  }
  const { code, message } = decoded.value.error;
  const parts = [code, message].filter((part) => part !== undefined);
  return parts.length === 0 ? '' : `: ${parts.join(': ')}`;
};

const retryAfterSeconds = (header: string | null): number | undefined =>
  header !== null && wholeSeconds.test(header.trim())
    ? Number(header.trim())
    : undefined;

const retryHint = (seconds: number | undefined): string =>
  seconds === undefined
    ? 'Retry in a minute'
    : `Retry after ${seconds} seconds, as Microsoft Graph asks`;

// The pathname only: query strings and ids make messages hard to read.
const pathOf = (url: string): string =>
  (URL.parse(url)?.pathname ?? url).replace('/v1.0', '');

export const graphFailure = (
  account: string,
  url: string,
  { status, retryAfter, body }: Answer,
): GraphRequestError => {
  const detail = errorDetail(body);
  const path = pathOf(url);
  switch (status) {
    case unauthorized:
      return new GraphAuthError({
        account,
        message: `Microsoft Graph rejected the sign-in of ${account} (HTTP 401${detail}). Ask the user to run: ${loginCommand('graph', account)}`,
      });
    case forbidden:
      return new GraphAccessError({
        account,
        message: `Microsoft Graph denied ${account} access to ${path} (HTTP 403${detail}). The account may lack permission for it, or its organization may block pim`,
      });
    case notFound:
      return new GraphNotFoundError({
        path,
        message: `Microsoft Graph found nothing at ${path} for ${account} (HTTP 404${detail})`,
      });
    case preconditionFailed:
      return new GraphConflictError({
        href: path,
        message: `${path} changed since you read it, so Microsoft Graph made no change (HTTP 412${detail}). Run "pim calendar get" again and check that the change still applies`,
      });
    case tooManyRequests: {
      const seconds = retryAfterSeconds(retryAfter);
      return new GraphThrottledError({
        account,
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
        message: `Microsoft Graph is limiting requests for ${account} (HTTP 429${detail}). ${retryHint(seconds)}`,
      });
    }
    default: {
      const seconds = retryAfterSeconds(retryAfter);
      return new GraphError({
        message: `Microsoft Graph failed on ${path} (HTTP ${status}${detail})${seconds === undefined ? '' : `. ${retryHint(seconds)}`}`,
      });
    }
  }
};

const preferHeader = (
  options: GraphOptions | undefined,
): Readonly<Record<string, string>> =>
  options?.prefer === undefined || options.prefer.length === 0
    ? {}
    : { prefer: options.prefer.join(', ') };

const requestHeaders = (
  accessToken: string,
  options: GraphOptions | undefined,
  write: GraphWrite | undefined,
): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${accessToken}`,
  accept: 'application/json',
  ...preferHeader(options),
  ...(write?.body === undefined ? {} : { 'content-type': 'application/json' }),
  ...(write?.ifMatch === undefined ? {} : { 'if-match': write.ifMatch }),
});

export const makeGraphClient = (
  {
    account,
    accessToken,
  }: { readonly account: string; readonly accessToken: string },
  fetch: GraphFetch,
): GraphClient => {
  const request = (
    url: string,
    options: GraphOptions | undefined,
    write?: GraphWrite,
  ): Effect.Effect<unknown, GraphRequestError> =>
    Effect.tryPromise({
      try: async (signal): Promise<Answer> => {
        const response = await fetch(url, {
          method: write?.method ?? 'GET',
          headers: requestHeaders(accessToken, options, write),
          ...(write?.body === undefined
            ? {}
            : { body: JSON.stringify(write.body) }),
          signal,
        });
        const body: unknown = await response.json().catch(() => undefined);
        return {
          ok: response.ok,
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
          body,
        };
      },
      catch: (cause) =>
        new GraphError({
          message: `The Microsoft Graph request for ${account} failed: ${String(cause)}`,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(requestTimeoutSeconds),
        orElse: () =>
          Effect.fail(
            new GraphError({
              message: `Microsoft Graph did not answer within ${requestTimeoutSeconds} seconds for ${account}${write === undefined ? '' : '. It may have made the change anyway: read the event again before you retry'}`,
            }),
          ),
      }),
      Effect.flatMap((answer) =>
        answer.ok
          ? Effect.succeed(answer.body)
          : Effect.fail(graphFailure(account, url, answer)),
      ),
    );

  const decode = <A>(url: string, schema: Schema.Decoder<A>, body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () =>
          new GraphError({
            message: `Microsoft Graph sent an unexpected answer for ${pathOf(url)}`,
          }),
      ),
    );

  const get = <A>(
    path: string,
    schema: Schema.Decoder<A>,
    options?: GraphOptions,
  ): Effect.Effect<A, GraphRequestError> => {
    const url = `${graphRoot}${path}`;
    return request(url, options).pipe(
      Effect.flatMap((body) => decode(url, schema, body)),
    );
  };

  const pages = (
    url: string,
    options: GraphOptions | undefined,
    found: ReadonlyArray<unknown>,
    count: number,
  ): Effect.Effect<ReadonlyArray<unknown>, GraphRequestError> =>
    request(url, options).pipe(
      Effect.flatMap((body) => decode(url, Page, body)),
      Effect.flatMap(({ value, nextLink }) => {
        const items = [...found, ...value];
        if (nextLink === undefined) {
          return Effect.succeed(items);
        }
        // The next link carries the access token's audience, so pim follows
        // it only within Microsoft Graph.
        if (!nextLink.startsWith(`${graphRoot}/`) || count >= maxPages) {
          return Effect.fail(
            new GraphError({
              message: `Microsoft Graph sent a next page link pim does not follow for ${pathOf(url)}`,
            }),
          );
        }
        return pages(nextLink, options, items, count + 1);
      }),
    );

  const send = <A>(
    write: GraphWrite,
    schema: Schema.Decoder<A>,
    options?: GraphOptions,
  ): Effect.Effect<A, GraphRequestError> => {
    const url = `${graphRoot}${write.path}`;
    return request(url, options, write).pipe(
      Effect.flatMap((body) => decode(url, schema, body)),
    );
  };

  return {
    account,
    get,
    list: (path, options) => pages(`${graphRoot}${path}`, options, [], 1),
    send,
  };
};
