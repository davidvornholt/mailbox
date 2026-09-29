import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import {
  type DeviceCode,
  makeMicrosoftAuth,
  type PostForm,
} from './microsoft-auth';

type Reply = { readonly status: number; readonly body: string };
type Call = { readonly url: string; readonly form: URLSearchParams };
type Field = readonly [name: string, value: string | number];

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
  it('asks for IMAP access with a refresh token and defaults the interval', async () => {
    const { calls, auth } = replying({
      status: 200,
      body: json(
        ['device_code', 'device-code'],
        ['user_code', 'ABCD1234'],
        ['verification_uri', 'https://login.microsoft.com/device'],
        ['expires_in', deviceCodeLifetimeSeconds],
      ),
    });

    expect(await Effect.runPromise(auth.requestDeviceCode)).toEqual({
      ...device,
      intervalSeconds: 5,
      expiresInSeconds: deviceCodeLifetimeSeconds,
    });
    expect(calls.map(({ url, form }) => ({ url, form: [...form] }))).toEqual([
      {
        url: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
        form: [
          ['client_id', '9e5f94bc-e8a4-4e73-b8be-63364c29d753'],
          [
            'scope',
            'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
          ],
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

    expect(await Effect.runPromise(auth.awaitSignIn(device))).toEqual({
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

    expect(await failureMessage(auth.awaitSignIn(device))).toBe(
      'Microsoft sign-in failed: AADSTS70000: The user declined.',
    );
  });

  it('fails when Microsoft returns no refresh token', async () => {
    const { auth } = replying(tokens(['access_token', 'access']));

    expect(await failureMessage(auth.awaitSignIn(device))).toContain(
      'no refresh token',
    );
  });
});

describe('refresh', () => {
  it('returns the rotated refresh token', async () => {
    const { calls, auth } = replying(
      tokens(['access_token', 'access'], ['refresh_token', 'rotated']),
    );

    expect(
      await Effect.runPromise(auth.refresh('me@outlook.com', 'current')),
    ).toEqual({ accessToken: 'access', refreshToken: 'rotated' });
    expect(calls[0]?.form.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.form.get('refresh_token')).toBe('current');
  });

  it('keeps the current refresh token when Microsoft omits a new one', async () => {
    const { auth } = replying(tokens(['access_token', 'access']));

    expect(
      await Effect.runPromise(auth.refresh('me@outlook.com', 'current')),
    ).toEqual({ accessToken: 'access', refreshToken: 'current' });
  });

  it('asks for a new login when Microsoft rejects the refresh token', async () => {
    const { auth } = replying(
      rejection('invalid_grant', 'AADSTS70008: The refresh token has expired.'),
    );

    expect(
      await failureMessage(auth.refresh('me@outlook.com', 'current')),
    ).toBe(
      'Microsoft rejected the stored sign-in for me@outlook.com: AADSTS70008: The refresh token has expired. Ask the user to run: mailbox login --account me@outlook.com',
    );
  });

  it('reports an HTTP failure without an OAuth error body', async () => {
    const { auth } = replying({
      status: 503,
      body: '<html>Unavailable</html>',
    });

    expect(
      await failureMessage(auth.refresh('me@outlook.com', 'current')),
    ).toBe('Microsoft sign-in failed with HTTP 503.');
  });

  it('reports a request that never reached Microsoft', async () => {
    const { auth } = replying();

    expect(
      await failureMessage(auth.refresh('me@outlook.com', 'current')),
    ).toBe('Microsoft sign-in request failed: Error: network down');
  });
});
