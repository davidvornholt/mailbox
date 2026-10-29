import { describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import {
  type DeviceCode,
  freshAccessToken,
  type MicrosoftApp,
  type MicrosoftTokens,
  makeMicrosoftAuth,
  type PostForm,
} from './auth';

type Reply = { readonly status: number; readonly body: string };
type Call = { readonly url: string; readonly form: URLSearchParams };
type Field = readonly [name: string, value: string | number];

const app: MicrosoftApp = {
  clientId: '00000000-0000-4000-8000-000000000001',
  scope: 'https://graph.microsoft.com/Calendars.Read offline_access',
  credential: 'graph',
};

const accessTokenLifetimeSeconds = 3600;
const deviceCodeLifetimeSeconds = 900;

// Answers each request with the next reply, as Microsoft's endpoints would.
const replying = (...replies: ReadonlyArray<Reply>) => {
  const calls: Array<Call> = [];
  const postForm: PostForm = (url, form) => {
    calls.push({ url, form });
    const reply = replies[calls.length - 1];
    return reply === undefined
      ? Promise.reject(new Error('network down'))
      : Promise.resolve(new Response(reply.body, { status: reply.status }));
  };
  return { calls, auth: makeMicrosoftAuth(postForm) };
};

// Builds a JSON body with Microsoft's snake_case field names.
const json = (...fields: ReadonlyArray<Field>) =>
  JSON.stringify(Object.fromEntries(fields));

const rejection = (error: string, description: string): Reply => ({
  status: 400,
  body: json(
    ['error', error],
    [
      'error_description',
      `${description} Trace ID: 1 Correlation ID: 2 Timestamp: 2026-09-29 12:00:00Z`,
    ],
  ),
});

const pending = rejection(
  'authorization_pending',
  'AADSTS70016: The user has not signed in yet.',
);

const tokens = (...fields: ReadonlyArray<Field>): Reply => ({
  status: 200,
  body: json(
    ['token_type', 'Bearer'],
    ['expires_in', accessTokenLifetimeSeconds],
    ...fields,
  ),
});

// A zero interval keeps the polling tests fast.
const device: DeviceCode = {
  deviceCode: 'device-code',
  userCode: 'ABCD1234',
  verificationUri: 'https://login.microsoft.com/device',
  intervalSeconds: 0,
  expiresInSeconds: 60,
};

const failureMessage = (effect: Effect.Effect<unknown, { message: string }>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message);

describe('requestDeviceCode', () => {
  it("asks for the app's access and defaults the interval", async () => {
    const { calls, auth } = replying({
      status: 200,
      body: json(
        ['device_code', 'device-code'],
        ['user_code', 'ABCD1234'],
        ['verification_uri', 'https://login.microsoft.com/device'],
        ['expires_in', deviceCodeLifetimeSeconds],
      ),
    });

    expect(await Effect.runPromise(auth.requestDeviceCode(app))).toEqual({
      ...device,
      intervalSeconds: 5,
      expiresInSeconds: deviceCodeLifetimeSeconds,
    });
    expect(calls.map(({ url, form }) => ({ url, form: [...form] }))).toEqual([
      {
        url: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
        form: [
          ['client_id', app.clientId],
          ['scope', app.scope],
        ],
      },
    ]);
  });
});

describe('awaitSignIn', () => {
  it('polls while sign-in is pending and returns the tokens', async () => {
    const replies = [
      pending,
      pending,
      tokens(['access_token', 'access'], ['refresh_token', 'refresh']),
    ];
    const { calls, auth } = replying(...replies);

    expect(await Effect.runPromise(auth.awaitSignIn(app, device))).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(calls).toHaveLength(replies.length);
    expect(calls.at(-1)?.form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(calls.at(-1)?.form.get('device_code')).toBe('device-code');
  });

  it("reports Microsoft's reason without its trace IDs", async () => {
    const { auth } = replying(
      rejection('authorization_declined', 'AADSTS70000: The user declined.'),
    );

    expect(await failureMessage(auth.awaitSignIn(app, device))).toBe(
      'Microsoft sign-in failed: AADSTS70000: The user declined.',
    );
  });

  it('fails when Microsoft returns no refresh token', async () => {
    const { auth } = replying(tokens(['access_token', 'access']));

    expect(await failureMessage(auth.awaitSignIn(app, device))).toContain(
      'no refresh token',
    );
  });
});

describe('signInInBrowser', () => {
  // Starts the sign-in, lets the browser call the redirect with the given
  // query, and returns the authorization request and what pim made of it.
  const signIn = (
    redirectQuery: (authorize: URLSearchParams) => string,
    ...replies: ReadonlyArray<Reply>
  ) => {
    const { calls, auth } = replying(...replies);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { url, awaitSignIn } = yield* auth.signInInBrowser(
            app,
            'me@example.com',
          );
          const authorize = new URL(url).searchParams;
          const redirect = authorize.get('redirect_uri') ?? '';
          const favicon = yield* Effect.promise(() =>
            fetch(`${redirect}/favicon.ico`),
          );
          yield* Effect.promise(() =>
            fetch(`${redirect}/?${redirectQuery(authorize)}`),
          );
          const result = yield* Effect.result(awaitSignIn);
          return { authorize, favicon: favicon.status, result, calls };
        }),
      ),
    );
  };

  it('redeems the code with the PKCE verifier at the same redirect', async () => {
    const { authorize, favicon, result, calls } = await signIn(
      (query) => `code=granted&state=${query.get('state')}`,
      tokens(['access_token', 'access'], ['refresh_token', 'refresh']),
    );

    expect(authorize.get('login_hint')).toBe('me@example.com');
    expect(authorize.get('code_challenge_method')).toBe('S256');
    expect(favicon).toBe(404);
    expect(result).toEqual(
      Result.succeed({ accessToken: 'access', refreshToken: 'refresh' }),
    );
    const form = calls[0]?.form;
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code')).toBe('granted');
    expect(form?.get('redirect_uri')).toBe(authorize.get('redirect_uri'));
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(form?.get('code_verifier') ?? ''),
    );
    expect(Buffer.from(digest).toString('base64url')).toBe(
      authorize.get('code_challenge') ?? '',
    );
  });

  it("reports Microsoft's reason when the browser returns an error", async () => {
    const { result, calls } = await signIn(
      (query) =>
        `error=access_denied&error_description=The+user+declined.&state=${query.get('state')}`,
    );

    expect(Result.isFailure(result) && result.failure.message).toBe(
      'Microsoft sign-in failed: The user declined.',
    );
    expect(calls).toEqual([]);
  });
});

describe('refresh', () => {
  it('returns the rotated refresh token', async () => {
    const { calls, auth } = replying(
      tokens(['access_token', 'access'], ['refresh_token', 'rotated']),
    );

    expect(
      await Effect.runPromise(auth.refresh(app, 'me@example.com', 'current')),
    ).toEqual({ accessToken: 'access', refreshToken: 'rotated' });
    expect(calls[0]?.form.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.form.get('client_id')).toBe(app.clientId);
    expect(calls[0]?.form.get('refresh_token')).toBe('current');
    expect(calls[0]?.form.get('scope')).toBe(app.scope);
  });

  it('keeps the current refresh token when Microsoft omits a new one', async () => {
    const { auth } = replying(tokens(['access_token', 'access']));

    expect(
      await Effect.runPromise(auth.refresh(app, 'me@example.com', 'current')),
    ).toEqual({ accessToken: 'access', refreshToken: 'current' });
  });

  it('asks for a new login when Microsoft rejects the refresh token', async () => {
    const { auth } = replying(
      rejection('invalid_grant', 'AADSTS70008: The refresh token has expired.'),
    );

    expect(
      await failureMessage(auth.refresh(app, 'me@example.com', 'current')),
    ).toBe(
      'Microsoft rejected the stored sign-in for me@example.com: AADSTS70008: The refresh token has expired. Ask the user to run: pim login --account me@example.com --only graph',
    );
  });

  it('reports an HTTP failure without an OAuth error body', async () => {
    const { auth } = replying({
      status: 503,
      body: '<html>Unavailable</html>',
    });

    expect(
      await failureMessage(auth.refresh(app, 'me@example.com', 'current')),
    ).toBe('Microsoft sign-in failed with HTTP 503.');
  });

  it('reports a request that never reached Microsoft', async () => {
    const { auth } = replying();

    expect(
      await failureMessage(auth.refresh(app, 'me@example.com', 'current')),
    ).toBe('Microsoft sign-in request failed: Error: network down');
  });
});

describe('freshAccessToken', () => {
  const trading = (refreshToken: string) => {
    const stored: Array<string> = [];
    const token = freshAccessToken('current', {
      refresh: (current): Effect.Effect<MicrosoftTokens> =>
        Effect.succeed({ accessToken: `access for ${current}`, refreshToken }),
      store: (rotated) =>
        Effect.sync(() => {
          stored.push(rotated);
        }),
    });
    return { stored, token };
  };

  it('stores a rotated refresh token', async () => {
    const { stored, token } = trading('rotated');
    expect(await Effect.runPromise(token)).toBe('access for current');
    expect(stored).toEqual(['rotated']);
  });

  it('leaves the keyring alone when the refresh token stays the same', async () => {
    const { stored, token } = trading('current');
    expect(await Effect.runPromise(token)).toBe('access for current');
    expect(stored).toEqual([]);
  });
});
