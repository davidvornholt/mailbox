import { Effect } from 'effect';
import type { Account } from '../accounts/account';
import { pimClientId } from './app';
import { type GraphFetch, makeGraphClient } from './client';
import { Graph } from './graph';

const notFoundCode = 404;

export type GraphRequest = {
  readonly url: string;
  readonly prefer: string | undefined;
};

// An account that reads Outlook calendars from the fake Microsoft Graph.
export const graphAccount: Account = {
  email: 'me@example.com',
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
  auth: 'password',
  graph: { clientId: pimClientId },
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Like Microsoft Graph, keeps only the selected fields of an item, of the
// items in a collection, and of the expanded items, which Microsoft Graph
// gives the fields selected for their parent.
const selectFields = (
  body: unknown,
  fields: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): unknown => {
  if (!isRecord(body)) {
    return body;
  }
  return Object.fromEntries(
    Object.entries(body).flatMap(([key, value]) => {
      if ((key === 'value' || expanded.has(key)) && Array.isArray(value)) {
        return [
          [key, value.map((item) => selectFields(item, fields, expanded))],
        ];
      }
      return fields.has(key) || key.startsWith('@odata.') ? [[key, value]] : [];
    }),
  );
};

// A Microsoft Graph that answers each path, without /v1.0, from a table, and
// records every request. A path with $skiptoken=<token> answers from
// "<path>?$skiptoken=<token>", and anything else gets 404. An answer keeps
// only the fields in $select.
export const fakeGraph = (routes: Readonly<Record<string, unknown>>) => {
  const answers = new Map(Object.entries(routes));
  const requests: Array<GraphRequest> = [];
  const fetch: GraphFetch = (url, init) => {
    requests.push({ url, prefer: init.headers.prefer });
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace('/v1.0', '');
    const token = searchParams.get('$skiptoken');
    const select = searchParams.get('$select');
    const expand = searchParams.get('$expand');
    const body = answers.get(
      token === null ? path : `${path}?$skiptoken=${token}`,
    );
    return Promise.resolve(
      body === undefined
        ? Response.json(
            { error: { code: 'ErrorItemNotFound', message: 'Not found.' } },
            { status: notFoundCode },
          )
        : Response.json(
            select === null
              ? body
              : selectFields(
                  body,
                  new Set(select.split(',')),
                  new Set(expand?.split(',')),
                ),
          ),
    );
  };
  const client = makeGraphClient(
    { account: graphAccount.email, accessToken: 'access' },
    fetch,
  );
  return {
    requests,
    client,
    graph: Graph.of({
      client: () => Effect.succeed(client),
      clientWith: () => client,
    }),
  };
};

// Runs the effect against a fake Microsoft Graph.
export const onFakeGraph = <A, E, R>(
  routes: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<A, E, R>,
) => {
  const { requests, graph } = fakeGraph(routes);
  return {
    requests,
    effect: effect.pipe(Effect.provideService(Graph, graph)),
  };
};
