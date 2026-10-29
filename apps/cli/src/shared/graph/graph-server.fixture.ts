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

// A Microsoft Graph that answers each path, without /v1.0, from a table, and
// records every request. A path with $skiptoken=<token> answers from
// "<path>?$skiptoken=<token>", and anything else gets 404.
export const fakeGraph = (routes: Readonly<Record<string, unknown>>) => {
  const answers = new Map(Object.entries(routes));
  const requests: Array<GraphRequest> = [];
  const fetch: GraphFetch = (url, init) => {
    requests.push({ url, prefer: init.headers.prefer });
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace('/v1.0', '');
    const token = searchParams.get('$skiptoken');
    const body = answers.get(
      token === null ? path : `${path}?$skiptoken=${token}`,
    );
    return Promise.resolve(
      body === undefined
        ? Response.json(
            { error: { code: 'ErrorItemNotFound', message: 'Not found.' } },
            { status: notFoundCode },
          )
        : Response.json(body),
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
