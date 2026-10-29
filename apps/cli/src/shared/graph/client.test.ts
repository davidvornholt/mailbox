import { describe, expect, it } from 'bun:test';
import { Effect, Result, Schema } from 'effect';
import { type GraphFetch, graphFailure, makeGraphClient } from './client';

type Call = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

const root = 'https://graph.microsoft.com/v1.0';

// Answers each request with the next response, as Microsoft Graph would.
const answering = (...responses: ReadonlyArray<() => Response>) => {
  const calls: Array<Call> = [];
  const fetch: GraphFetch = (url, init) => {
    calls.push({ url, headers: init.headers });
    const response = responses[calls.length - 1];
    return response === undefined
      ? Promise.reject(new Error('network down'))
      : Promise.resolve(response());
  };
  return {
    calls,
    client: makeGraphClient(
      { account: 'me@example.com', accessToken: 'access' },
      fetch,
    ),
  };
};

const page = (value: ReadonlyArray<unknown>, nextLink?: string) => () =>
  Response.json({
    value,
    ...(nextLink === undefined ? {} : { '@odata.nextLink': nextLink }),
  });

const failing =
  (status: number, headers: Record<string, string> = {}) =>
  () =>
    Response.json(
      { error: { code: 'ErrorCode', message: 'Something went wrong.' } },
      { status, headers },
    );

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

describe('makeGraphClient', () => {
  it('sends the access token and preferences, and decodes the answer', async () => {
    const { calls, client } = answering(() => Response.json({ id: 'cal-1' }));

    const result = await run(
      client.get('/me/calendars/cal-1', Schema.Struct({ id: Schema.String }), {
        prefer: ['outlook.timezone="UTC"', 'outlook.body-content-type="text"'],
      }),
    );

    expect(result).toEqual(Result.succeed({ id: 'cal-1' }));
    expect(calls).toEqual([
      {
        url: `${root}/me/calendars/cal-1`,
        headers: {
          authorization: 'Bearer access',
          accept: 'application/json',
          prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
        },
      },
    ]);
  });

  it('follows next page links and keeps the preferences', async () => {
    const { calls, client } = answering(
      page([{ id: 'a' }], `${root}/me/calendars?$skiptoken=page-2`),
      page([{ id: 'b' }], `${root}/me/calendars?$skiptoken=page-3`),
      page([{ id: 'c' }]),
    );

    const result = await run(
      client.list('/me/calendars', { prefer: ['outlook.timezone="UTC"'] }),
    );

    expect(result).toEqual(
      Result.succeed([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    );
    expect(calls.map(({ url }) => url)).toEqual([
      `${root}/me/calendars`,
      `${root}/me/calendars?$skiptoken=page-2`,
      `${root}/me/calendars?$skiptoken=page-3`,
    ]);
    expect(calls.every(({ headers }) => headers.prefer !== undefined)).toBe(
      true,
    );
  });

  it('does not follow a next page link outside Microsoft Graph', async () => {
    const { calls, client } = answering(
      page([{ id: 'a' }], 'https://example.com/me/calendars?$skiptoken=x'),
    );

    const result = await run(client.list('/me/calendars'));

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      failure: {
        _tag: 'GraphError',
        message:
          'Microsoft Graph sent a next page link pim does not follow for /me/calendars',
      },
    });
  });

  it('stops at a next page link that never ends', async () => {
    const endless = page([], `${root}/me/calendars?$skiptoken=again`);
    const { calls, client } = answering(
      ...Array.from({ length: 101 }, () => endless),
    );

    const result = await run(client.list('/me/calendars'));

    expect(calls).toHaveLength(100);
    expect(result).toMatchObject({ failure: { _tag: 'GraphError' } });
  });

  it('reports an answer in an unexpected form', async () => {
    const { client } = answering(() => Response.json({ items: [] }));

    const result = await run(client.list('/me/calendars'));

    expect(result).toMatchObject({
      failure: {
        _tag: 'GraphError',
        message: 'Microsoft Graph sent an unexpected answer for /me/calendars',
      },
    });
  });

  it('reports a request that does not reach Microsoft Graph', async () => {
    const { client } = answering();

    const result = await run(client.get('/me/calendars', Schema.Unknown));

    expect(result).toMatchObject({
      failure: {
        _tag: 'GraphError',
        message:
          'The Microsoft Graph request for me@example.com failed: Error: network down',
      },
    });
  });

  it('maps an error answer by its status', async () => {
    const { client } = answering(failing(403));

    const result = await run(client.get('/me/calendars/cal-1', Schema.Unknown));

    expect(result).toMatchObject({ failure: { _tag: 'GraphAccessError' } });
  });
});

describe('graphFailure', () => {
  const answer = (status: number, retryAfter: string | null = null) => ({
    ok: false,
    status,
    retryAfter,
    body: { error: { code: 'ErrorCode', message: 'Something went wrong.' } },
  });
  const url = `${root}/me/calendars/cal-1/calendarView?startDateTime=x`;
  const failure = (status: number, retryAfter?: string) =>
    graphFailure('me@example.com', url, answer(status, retryAfter ?? null));

  it('asks for a new sign-in after HTTP 401', () => {
    expect(failure(401)).toMatchObject({
      _tag: 'GraphAuthError',
      account: 'me@example.com',
      message:
        'Microsoft Graph rejected the sign-in of me@example.com (HTTP 401: ErrorCode: Something went wrong.). Ask the user to run: pim login --account me@example.com --only graph',
    });
  });

  it('reports missing access after HTTP 403', () => {
    expect(failure(403)).toMatchObject({
      _tag: 'GraphAccessError',
      message:
        'Microsoft Graph denied me@example.com access to /me/calendars/cal-1/calendarView (HTTP 403: ErrorCode: Something went wrong.). The account may lack permission for it, or its organization may block pim',
    });
  });

  it('reports a missing resource after HTTP 404', () => {
    expect(failure(404)).toMatchObject({
      _tag: 'GraphNotFoundError',
      path: '/me/calendars/cal-1/calendarView',
    });
  });

  it('passes on how long to wait after HTTP 429', () => {
    expect(failure(429, '30')).toMatchObject({
      _tag: 'GraphThrottledError',
      retryAfterSeconds: 30,
      message:
        'Microsoft Graph is limiting requests for me@example.com (HTTP 429: ErrorCode: Something went wrong.). Retry after 30 seconds, as Microsoft Graph asks',
    });
    expect(failure(429)).toMatchObject({
      _tag: 'GraphThrottledError',
      message: expect.stringContaining('Retry in a minute'),
    });
    expect(failure(429)).not.toHaveProperty('retryAfterSeconds');
  });

  it('reports other statuses with the wait Microsoft Graph asks for', () => {
    expect(failure(503, '5')).toMatchObject({
      _tag: 'GraphError',
      message:
        'Microsoft Graph failed on /me/calendars/cal-1/calendarView (HTTP 503: ErrorCode: Something went wrong.). Retry after 5 seconds, as Microsoft Graph asks',
    });
    expect(
      graphFailure('me@example.com', url, {
        ok: false,
        status: 500,
        retryAfter: null,
        body: undefined,
      }),
    ).toMatchObject({
      message:
        'Microsoft Graph failed on /me/calendars/cal-1/calendarView (HTTP 500)',
    });
  });
});
