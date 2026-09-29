import { Duration, Effect, Either, Schema } from 'effect';
import { OAuthError } from '../errors/errors';

// Microsoft issues tokens only to registered apps. mailbox borrows Mozilla
// Thunderbird's public client ID, which works for personal and most work or
// school accounts without an app registration of its own, so Microsoft's
// consent screen names Thunderbird.
const clientId = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
// The common tenant accepts both personal (Outlook.com) and work or school
// (Microsoft 365) accounts.
const endpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0';
// offline_access adds the refresh token that later commands trade for access
// tokens, so one sign-in lasts until Microsoft revokes it.
const scope = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
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
  deviceCode: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey('device_code'),
  ),
  userCode: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey('user_code'),
  ),
  verificationUri: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey('verification_uri'),
  ),
  intervalSeconds: Schema.optionalWith(Schema.Number, {
    default: () => defaultIntervalSeconds,
  }).pipe(Schema.fromKey('interval')),
  expiresInSeconds: Schema.propertySignature(Schema.Number).pipe(
    Schema.fromKey('expires_in'),
  ),
});

export type DeviceCode = typeof DeviceCodeResponse.Type;

const TokenResponse = Schema.Struct({
  accessToken: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey('access_token'),
  ),
  refreshToken: Schema.optional(Schema.String).pipe(
    Schema.fromKey('refresh_token'),
  ),
});

export type MicrosoftTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
};

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  description: Schema.optional(Schema.String).pipe(
    Schema.fromKey('error_description'),
  ),
});

type OAuthFailure = { readonly error: string; readonly description: string };

// Resolves to the decoded body, or to the OAuth error Microsoft answered with.
const post = <A, I>(
  postForm: PostForm,
  path: string,
  form: URLSearchParams,
  success: Schema.Schema<A, I>,
): Effect.Effect<Either.Either<A, OAuthFailure>, OAuthError> =>
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
    Effect.timeoutFail({
      duration: Duration.seconds(requestTimeoutSeconds),
      onTimeout: () =>
        new OAuthError({
          message: `Microsoft sign-in did not respond within ${requestTimeoutSeconds} seconds.`,
        }),
    }),
    Effect.flatMap(
      ({
        ok,
        status,
        body,
      }): Effect.Effect<Either.Either<A, OAuthFailure>, OAuthError> =>
        ok
          ? Schema.decodeUnknown(success)(body).pipe(
              Effect.map(Either.right),
              Effect.mapError(
                () =>
                  new OAuthError({
                    message: `Microsoft sign-in sent an unexpected response (HTTP ${status}).`,
                  }),
              ),
            )
          : Schema.decodeUnknown(ErrorResponse)(body).pipe(
              Effect.map(({ error, description }) =>
                Either.left({
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
): Effect.Effect<DeviceCode, OAuthError> =>
  post(
    postForm,
    'devicecode',
    new URLSearchParams([
      ['client_id', clientId],
      ['scope', scope],
    ]),
    DeviceCodeResponse,
  ).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (failure) =>
          Effect.fail(
            new OAuthError({
              message: `Microsoft sign-in could not start: ${failure.description}`,
            }),
          ),
        onRight: Effect.succeed,
      }),
    ),
  );

const pollForTokens = (
  postForm: PostForm,
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
          ['client_id', clientId],
          ['device_code', device.deviceCode],
        ]),
        TokenResponse,
      ),
    ),
    Effect.flatMap(
      Either.match({
        onLeft: (failure) => {
          switch (failure.error) {
            case 'authorization_pending':
              return pollForTokens(postForm, device, intervalSeconds);
            case 'slow_down':
              return pollForTokens(
                postForm,
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
        onRight: ({ accessToken, refreshToken }) =>
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
  device: DeviceCode,
): Effect.Effect<MicrosoftTokens, OAuthError> =>
  pollForTokens(postForm, device, device.intervalSeconds).pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(device.expiresInSeconds),
      onTimeout: () =>
        new OAuthError({
          message:
            'The sign-in code expired before sign-in finished. Run mailbox login again.',
        }),
    }),
  );

// Microsoft rotates refresh tokens and may omit the new one, in which case the
// current token stays valid.
const refresh = (
  postForm: PostForm,
  account: string,
  refreshToken: string,
): Effect.Effect<MicrosoftTokens, OAuthError> =>
  post(
    postForm,
    'token',
    new URLSearchParams([
      ['grant_type', 'refresh_token'],
      ['client_id', clientId],
      ['refresh_token', refreshToken],
      ['scope', scope],
    ]),
    TokenResponse,
  ).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (failure) =>
          Effect.fail(
            new OAuthError({
              message:
                failure.error === 'invalid_grant'
                  ? `Microsoft rejected the stored sign-in for ${account}: ${failure.description} Ask the user to run: mailbox login --account ${account}`
                  : `Microsoft token refresh for ${account} failed: ${failure.description}`,
            }),
          ),
        onRight: (tokens) =>
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
    requestDeviceCode: requestDeviceCode(postForm),
    awaitSignIn: (device: DeviceCode) => awaitSignIn(postForm, device),
    refresh: (account: string, refreshToken: string) =>
      refresh(postForm, account, refreshToken),
  }) as const;

const postWithFetch: PostForm = (url, form, signal) =>
  fetch(url, { method: 'POST', body: form, signal });

export class MicrosoftAuth extends Effect.Service<MicrosoftAuth>()(
  'mail/MicrosoftAuth',
  { succeed: makeMicrosoftAuth(postWithFetch) },
) {}
