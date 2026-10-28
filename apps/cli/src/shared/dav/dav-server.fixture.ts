import { type Fetch, makeDavClient } from './client';

const multiStatusCode = 207;
const notFoundCode = 404;

export type FakeReply = {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type RecordedRequest = {
  readonly method: string;
  readonly url: string;
  readonly depth: string | null;
  readonly authorization: string | null;
  readonly headers: Headers;
  readonly body: string;
};

export const davLogin = {
  account: 'me@example.com',
  url: 'https://dav.example.com/',
  user: 'me-dav',
  password: 'secret',
} as const;

// A DAV server that answers "METHOD /path" from a table, with 404 for
// anything else, and records every request. "METHOD /folder/*" answers for
// any resource in the folder without its own route.
export const fakeDavServer = (routes: Readonly<Record<string, FakeReply>>) => {
  const requests: Array<RecordedRequest> = [];
  const fetch: Fetch = (url, init) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({
      method,
      url,
      depth: headers.get('depth'),
      authorization: headers.get('authorization'),
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    });
    const { pathname } = new URL(url);
    const folder = pathname.slice(0, pathname.lastIndexOf('/') + 1);
    const reply =
      routes[`${method} ${pathname}`] ?? routes[`${method} ${folder}*`];
    return Promise.resolve(
      reply === undefined
        ? new Response('no such resource', { status: notFoundCode })
        : new Response(reply.body ?? '', {
            status: reply.status ?? multiStatusCode,
            ...(reply.headers === undefined ? {} : { headers: reply.headers }),
          }),
    );
  };
  return { client: makeDavClient(davLogin, fetch), requests };
};

export const multistatus = (...responses: ReadonlyArray<string>): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:ical="http://apple.com/ns/ical/">${responses.join('')}</d:multistatus>`;

export const davResponse = (href: string, props: string): string =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

// Discovery for a user whose principal is /principals/me/, with calendars
// under /calendars/me/ and address books under /addressbooks/me/.
export const discoveryRoutes: Readonly<Record<string, FakeReply>> = {
  'PROPFIND /': {
    body: multistatus(
      davResponse(
        '/',
        '<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>',
      ),
    ),
  },
  'PROPFIND /principals/me/': {
    body: multistatus(
      davResponse(
        '/principals/me/',
        '<d:displayname>Me</d:displayname><c:calendar-home-set><d:href>/calendars/me/</d:href></c:calendar-home-set><card:addressbook-home-set><d:href>/addressbooks/me/</d:href></card:addressbook-home-set><c:calendar-user-address-set><d:href>mailto:me@example.com</d:href><d:href>/principals/me/</d:href></c:calendar-user-address-set>',
      ),
    ),
  },
};
