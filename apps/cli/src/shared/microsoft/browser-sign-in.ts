import { Effect, type Scope } from 'effect';
import { OAuthError } from '../errors/accounts';
import type { MicrosoftApp } from './auth';

const authorizeEndpoint =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

// What a browser sign-in returns for redeeming at the token endpoint. The
// PKCE verifier proves that the code came back to the process that asked.
export type AuthorizationGrant = {
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
};

export type BrowserSignIn = {
  readonly url: string;
  readonly grant: Effect.Effect<AuthorizationGrant, OAuthError>;
};

// RFC 7636 recommends 32 random bytes for a PKCE verifier; the state uses
// the same.
const randomBytes = 32;

const randomToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(randomBytes))).toString(
    'base64url',
  );

const challengeFor = (verifier: string) =>
  Effect.promise(() =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).pipe(Effect.map((digest) => Buffer.from(digest).toString('base64url')));

// Microsoft redirects the browser to a server on this computer that lives
// only while the sign-in runs (RFC 8252). Microsoft matches the registered
// redirect http://localhost on any port.
export const startBrowserSignIn = (
  app: MicrosoftApp,
  loginHint: string,
): Effect.Effect<BrowserSignIn, OAuthError, Scope.Scope> =>
  Effect.gen(function* () {
    const verifier = randomToken();
    const state = randomToken();
    const challenge = yield* challengeFor(verifier);
    const callback = Promise.withResolvers<URLSearchParams>();
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: (request) => {
              const params = new URL(request.url).searchParams;
              // Other requests, such as the browser's favicon, are not the
              // redirect.
              if (params.get('state') !== state) {
                return new Response('Not found', { status: 404 });
              }
              callback.resolve(params);
              return new Response(
                params.has('code')
                  ? 'Signed in. You can close this tab and return to pim.'
                  : 'Sign-in failed. Return to pim for the reason.',
              );
            },
          }),
        catch: (cause) =>
          new OAuthError({
            message: `Could not start the local server for Microsoft sign-in: ${String(cause)}`,
          }),
      }),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const redirectUri = `http://localhost:${server.port}`;
    const query = new URLSearchParams([
      ['client_id', app.clientId],
      ['response_type', 'code'],
      ['redirect_uri', redirectUri],
      ['scope', app.scope],
      ['state', state],
      ['code_challenge', challenge],
      ['code_challenge_method', 'S256'],
      ['login_hint', loginHint],
    ]);
    const grant = Effect.promise(() => callback.promise).pipe(
      Effect.flatMap((params) => {
        const code = params.get('code');
        return code === null
          ? Effect.fail(
              new OAuthError({
                message: `Microsoft sign-in failed: ${params.get('error_description') ?? params.get('error') ?? 'no authorization code returned.'}`,
              }),
            )
          : Effect.succeed({ code, redirectUri, verifier });
      }),
    );
    return { url: `${authorizeEndpoint}?${query}`, grant };
  });
