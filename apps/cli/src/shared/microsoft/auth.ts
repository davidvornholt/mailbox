import { Context, Duration, Effect, Layer, Result, Schema } from 'effect';
import { type CredentialKind, loginCommand } from '../accounts/secrets';
import { OAuthError } from '../errors/accounts';

// The app registration pim signs in as, the access it asks for, and the
// keyring credential that keeps the sign-in.
export type MicrosoftApp = {
  readonly clientId: string;
  // offline_access adds the refresh token that later commands trade for
  // access tokens, so one sign-in lasts until Microsoft revokes it.
  readonly scope: string;
  readonly credential: CredentialKind;
};

// The common tenant accepts both personal (Outlook.com) and work or school
// (Microsoft 365) accounts.
const endpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const deviceCodeGrant = 'urn:ietf:params:oauth:grant-type:device_code';
// RFC 8628: poll every 5 seconds unless told otherwise, and 5 seconds slower
// after each slow_down.
const defaultIntervalSeconds = 5;
const slowDownSeconds = 5;
const requestTimeoutSeconds = 30;
// Microsoft appends trace and correlation IDs that only matter to its support.
const traceSuffix = /\s+Trace ID:.*$/su;

// Posts a form to a Microsoft identity endpoint. Injected so tests run without
// the network.
export type PostForm = (
  url: string,
  form: URLSearchParams,
  signal: AbortSignal,
) => Promise<Response>;

const DeviceCodeResponse = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  intervalSeconds: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultIntervalSeconds)),
  ),
  expiresInSeconds: Schema.Number,
}).pipe(
  Schema.encodeKeys({
    deviceCode: 'device_code',
    userCode: 'user_code',
    verificationUri: 'verification_uri',
    intervalSeconds: 'interval',
    expiresInSeconds: 'expires_in',
  }),
);

export type DeviceCode = typeof DeviceCodeResponse.Type;

const TokenResponse = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
}).pipe(
  Schema.encodeKeys({
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
  }),
);

export type MicrosoftTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
};

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  description: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ description: 'error_description' }));

type OAuthFailure = { readonly error: string; readonly description: string };

// Resolves to the decoded body, or to the OAuth error Microsoft answered with.
const post = <A>(
  postForm: PostForm,
  path: string,
  form: URLSearchParams,
  success: Schema.Decoder<A>,
): Effect.Effect<Result.Result<A, OAuthFailure>, OAuthError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await postForm(`${endpoint}/${path}`, form, signal);
      const body: unknown = await response.json().catch(() => undefined);
      return { ok: response.ok, status: response.status, body };
    },
    catch: (cause) =>
      new OAuthError({
        message: `Microsoft sign-in request failed: ${String(cause)}`,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(requestTimeoutSeconds),
      orElse: () =>
        Effect.fail(
          new OAuthError({
            message: `Microsoft sign-in did not respond within ${requestTimeoutSeconds} seconds.`,
          }),
        ),
    }),
    Effect.flatMap(
      ({
        ok,
        status,
        body,
      }): Effect.Effect<Result.Result<A, OAuthFailure>, OAuthError> =>
        ok
          ? Schema.decodeUnknownEffect(success)(body).pipe(
              Effect.map(Result.succeed),
              Effect.mapError(
                () =>
                  new OAuthError({
                    message: `Microsoft sign-in sent an unexpected response (HTTP ${status}).`,
                  }),
              ),
            )
          : Schema.decodeUnknownEffect(ErrorResponse)(body).pipe(
              Effect.map(({ error, description }) =>
                Result.fail({
                  error,
                  description:
                    description?.replace(traceSuffix, '').trim() || error,
                }),
              ),
              Effect.mapError(
                () =>
                  new OAuthError({
                    message: `Microsoft sign-in failed with HTTP ${status}.`,
                  }),
              ),
            ),
    ),
  );

const requestDeviceCode = (
  postForm: PostForm,
  app: MicrosoftApp,
): Effect.Effect<DeviceCode, OAuthError> =>
  post(
    postForm,
    'devicecode',
    new URLSearchParams([
      ['client_id', app.clientId],
      ['scope', app.scope],
    ]),
    DeviceCodeResponse,
  ).pipe(
    Effect.flatMap(
      Result.match({
        onFailure: (failure) =>
          Effect.fail(
            new OAuthError({
              message: `Microsoft sign-in could not start: ${failure.description}`,
            }),
          ),
        onSuccess: Effect.succeed,
      }),
    ),
  );

const pollForTokens = (
  postForm: PostForm,
  app: MicrosoftApp,
  device: DeviceCode,
  intervalSeconds: number,
): Effect.Effect<MicrosoftTokens, OAuthError> =>
  Effect.sleep(Duration.seconds(intervalSeconds)).pipe(
    Effect.andThen(
      post(
        postForm,
        'token',
        new URLSearchParams([
          ['grant_type', deviceCodeGrant],
          ['client_id', app.clientId],
          ['device_code', device.deviceCode],
        ]),
        TokenResponse,
      ),
    ),
    Effect.flatMap(
      Result.match({
        onFailure: (failure) => {
          switch (failure.error) {
            case 'authorization_pending':
              return pollForTokens(postForm, app, device, intervalSeconds);
            case 'slow_down':
              return pollForTokens(
                postForm,
                app,
                device,
                intervalSeconds + slowDownSeconds,
              );
            default:
              return Effect.fail(
                new OAuthError({
                  message: `Microsoft sign-in failed: ${failure.description}`,
                }),
              );
          }
        },
        onSuccess: ({ accessToken, refreshToken }) =>
          refreshToken === undefined
            ? Effect.fail(
                new OAuthError({
                  message: 'Microsoft sign-in returned no refresh token.',
                }),
              )
            : Effect.succeed({ accessToken, refreshToken }),
      }),
    ),
  );

// Waits until the user enters the code and signs in, or the code expires.
const awaitSignIn = (
  postForm: PostForm,
  app: MicrosoftApp,
  device: DeviceCode,
): Effect.Effect<MicrosoftTokens, OAuthError> =>
  pollForTokens(postForm, app, device, device.intervalSeconds).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(device.expiresInSeconds),
      orElse: () =>
        Effect.fail(
          new OAuthError({
            message:
              'The sign-in code expired before sign-in finished. Run pim login again.',
          }),
        ),
    }),
  );

// Microsoft rotates refresh tokens and may omit the new one, in which case the
// current token stays valid.
const refresh = (
  postForm: PostForm,
  app: MicrosoftApp,
  account: string,
  refreshToken: string,
): Effect.Effect<MicrosoftTokens, OAuthError> =>
  post(
    postForm,
    'token',
    new URLSearchParams([
      ['grant_type', 'refresh_token'],
      ['client_id', app.clientId],
      ['refresh_token', refreshToken],
      ['scope', app.scope],
    ]),
    TokenResponse,
  ).pipe(
    Effect.flatMap(
      Result.match({
        onFailure: (failure) =>
          Effect.fail(
            new OAuthError({
              message:
                failure.error === 'invalid_grant'
                  ? `Microsoft rejected the stored sign-in for ${account}: ${failure.description} Ask the user to run: ${loginCommand(app.credential, account)}`
                  : `Microsoft token refresh for ${account} failed: ${failure.description}`,
            }),
          ),
        onSuccess: (tokens) =>
          Effect.succeed({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? refreshToken,
          }),
      }),
    ),
  );

// Sign-in uses the device code flow: the user opens a Microsoft page in any
// browser and enters a short code, so it also works over SSH.
export const makeMicrosoftAuth = (postForm: PostForm) =>
  ({
    requestDeviceCode: (app: MicrosoftApp) => requestDeviceCode(postForm, app),
    awaitSignIn: (app: MicrosoftApp, device: DeviceCode) =>
      awaitSignIn(postForm, app, device),
    refresh: (app: MicrosoftApp, account: string, refreshToken: string) =>
      refresh(postForm, app, account, refreshToken),
  }) as const;

const postWithFetch: PostForm = (url, form, signal) =>
  fetch(url, { method: 'POST', body: form, signal });

export class MicrosoftAuth extends Context.Service<
  MicrosoftAuth,
  ReturnType<typeof makeMicrosoftAuth>
>()('shared/MicrosoftAuth') {
  static readonly layer = Layer.succeed(
    MicrosoftAuth,
    MicrosoftAuth.of(makeMicrosoftAuth(postWithFetch)),
  );
}

// A Microsoft access token lasts about an hour, so each command trades the
// stored refresh token for a new one. Keeping the rotated refresh token
// extends the sign-in, which would otherwise expire 90 days after `pim login`.
export const freshAccessToken = <RefreshError, StoreError>(
  stored: string,
  credentials: {
    readonly refresh: (
      refreshToken: string,
    ) => Effect.Effect<MicrosoftTokens, RefreshError>;
    readonly store: (refreshToken: string) => Effect.Effect<void, StoreError>;
  },
): Effect.Effect<string, RefreshError | StoreError> =>
  credentials.refresh(stored).pipe(
    Effect.tap((tokens) =>
      tokens.refreshToken === stored
        ? Effect.void
        : credentials.store(tokens.refreshToken),
    ),
    Effect.map((tokens) => tokens.accessToken),
  );
