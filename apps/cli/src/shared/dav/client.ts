import { Duration, Effect } from 'effect';
import type { DavSettings } from '../accounts/account';
import { loginCommand } from '../accounts/secrets';
import {
  DavAuthError,
  DavError,
  DavNotFoundError,
  type DavRequestError,
} from '../errors/dav';
import { type DavResource, isSuccessStatus, parseMultistatus } from './xml';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type DavLogin = DavSettings & {
  readonly account: string;
  readonly password: string;
};

export type DavRequest = {
  readonly method: string;
  // A path from a DAV response, or an absolute URL.
  readonly href: string;
  readonly depth?: '0' | '1';
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type DavReply = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
};

// Cap each request so one unresponsive server can't stall a command.
const requestTimeoutSeconds = 30;
const requestTimeout = Duration.seconds(requestTimeoutSeconds);
const httpUnauthorized = 401;
const httpForbidden = 403;
const httpNotFound = 404;
const xmlContentType = 'application/xml; charset=utf-8';

// Every prefix the request bodies use; the server answers with its own.
const xmlNamespaces =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"';

export const xmlBody = (element: string, content: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<${element} ${xmlNamespaces}>${content}</${element}>`;

const failure = (
  login: DavLogin,
  request: DavRequest,
  reply: DavReply,
): DavRequestError => {
  if (reply.status === httpUnauthorized) {
    return new DavAuthError({
      account: login.account,
      message: `${new URL(login.url).host} rejected the DAV login for ${login.account} (user ${login.user}). Ask the user to run: ${loginCommand('dav', login.account)}`,
    });
  }
  if (reply.status === httpNotFound) {
    return new DavNotFoundError({
      href: request.href,
      message: `${request.href} does not exist on ${new URL(login.url).host}`,
    });
  }
  // The response body stays out of the message: an error page can echo the
  // request, including the password and the authorization header.
  const reason =
    reply.status === httpForbidden ? ': the server forbids it' : '';
  return new DavError({
    message: `${request.method} ${request.href} failed with HTTP ${reply.status}${reason}`,
  });
};

// A client for one account's DAV server. Requests resolve hrefs against the
// configured url and log in with HTTP Basic authentication.
export const makeDavClient = (login: DavLogin, fetch: Fetch) => {
  const authorization = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`;

  const { origin } = new URL(login.url);

  // The password only goes to the configured server, even when an href from
  // a command line or a server response names another host.
  const target = (href: string): Effect.Effect<URL, DavError> => {
    const url = URL.parse(href, login.url);
    return url?.origin === origin
      ? Effect.succeed(url)
      : Effect.fail(
          new DavError({
            message: `${href} is not on ${login.account}'s DAV server ${origin}`,
          }),
        );
  };

  const exchange = (
    url: URL,
    request: DavRequest,
  ): Effect.Effect<DavReply, DavRequestError> =>
    Effect.tryPromise({
      try: async (signal): Promise<DavReply> => {
        const response = await fetch(url.href, {
          method: request.method,
          headers: {
            authorization,
            ...(request.depth === undefined ? {} : { depth: request.depth }),
            ...(request.body === undefined
              ? {}
              : { 'content-type': request.contentType ?? xmlContentType }),
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal,
        });
        return {
          status: response.status,
          headers: response.headers,
          body: await response.text(),
        };
      },
      catch: (cause) =>
        new DavError({
          message: `${request.method} ${request.href} failed: ${String(cause)}`,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () =>
          Effect.fail(
            new DavError({
              message: `${request.method} ${request.href} timed out after ${requestTimeoutSeconds}s`,
            }),
          ),
      }),
      Effect.flatMap((reply) =>
        isSuccessStatus(reply.status)
          ? Effect.succeed(reply)
          : Effect.fail(failure(login, request, reply)),
      ),
    );

  const send = (
    request: DavRequest,
  ): Effect.Effect<DavReply, DavRequestError> =>
    target(request.href).pipe(Effect.flatMap((url) => exchange(url, request)));

  const multistatus = (
    method: 'PROPFIND' | 'REPORT',
    href: string,
    depth: '0' | '1',
    body: string,
  ): Effect.Effect<ReadonlyArray<DavResource>, DavRequestError> =>
    send({ method, href, depth, body }).pipe(
      Effect.flatMap((reply) => parseMultistatus(reply.body)),
    );

  return {
    login,
    send,
    // props is the content of <d:prop>, such as "<d:displayname/>".
    propfind: (href: string, depth: '0' | '1', props: string) =>
      multistatus(
        'PROPFIND',
        href,
        depth,
        xmlBody('d:propfind', `<d:prop>${props}</d:prop>`),
      ),
    report: (href: string, depth: '0' | '1', body: string) =>
      multistatus('REPORT', href, depth, body),
  };
};

export type DavClient = ReturnType<typeof makeDavClient>;
