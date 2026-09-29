import { Duration, Effect, Exit, Ref } from 'effect';
import { ImapFlow } from 'imapflow';
import {
  AccountSearchTimeoutError,
  ImapError,
  type MailError,
} from '../errors/errors';
import type { Account } from '../schemas/account';

export type WarmClient = {
  usable: boolean;
  close: () => void;
  logout: () => Promise<void>;
};

const accountSearchTimeoutSeconds = 30;
const retiredClients = new WeakSet<object>();

const beginRetirement = (client: object): boolean => {
  if (retiredClients.has(client)) {
    return false;
  }
  retiredClients.add(client);
  return true;
};

export const retireClient = (client: WarmClient): Effect.Effect<void> =>
  Effect.sync(() => {
    if (beginRetirement(client)) {
      client.close();
    }
  });

// A password for password accounts, or a Microsoft access token for XOAUTH2.
export type ImapLogin =
  | { readonly pass: string }
  | { readonly accessToken: string };

export const makeClient = (account: Account, login: ImapLogin): ImapFlow => {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    // Force STARTTLS on non-implicit-TLS connections so the credential is never sent in cleartext; leave it unset for secure=true, which imapflow rejects alongside doSTARTTLS.
    doSTARTTLS: account.secure ? undefined : true,
    auth: { user: account.user, ...login },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    // Backstop for operations outside global search and for connection phases.
    socketTimeout: 60_000,
  });
  client.on('error', () => {
    Effect.runSync(retireClient(client));
  });
  return client;
};

// The tag, status, and response code before a server's reason, such as
// "3 NO [AUTHENTICATIONFAILED] ".
const replyPrefix = /^\S+\s+(?:NO|BAD)\s+(?:\[[^\]]*\]\s*)?/u;
const finalPeriod = /\.$/u;

// imapflow marks a rejected login with authenticationFailed and keeps the
// server's reply, such as "3 NO [AUTHENTICATIONFAILED] Invalid credentials".
// Resolves to the server's reason, or undefined for other failures.
const loginRejection = (cause: unknown): string | undefined => {
  if (
    typeof cause !== 'object' ||
    cause === null ||
    !('authenticationFailed' in cause) ||
    cause.authenticationFailed !== true
  ) {
    return undefined;
  }
  const reply =
    'response' in cause && typeof cause.response === 'string'
      ? cause.response
      : '';
  const reason = reply.replace(replyPrefix, '').trim().replace(finalPeriod, '');
  return reason || (cause instanceof Error ? cause.message : 'no reason given');
};

const rejectedLoginMessage = (account: Account, reason: string): string =>
  account.auth === 'password'
    ? `${account.host} rejected the password: ${reason}. Check the password; some providers, such as Gmail, require an app password.`
    : `${account.host} rejected the Microsoft sign-in: ${reason}. Check that the sign-in used ${account.user} and that the mailbox allows IMAP.`;

export const connectClient = (
  client: ImapFlow,
  account: Account,
): Effect.Effect<void, ImapError> =>
  Effect.tryPromise({
    try: () => client.connect(),
    catch: (cause) => {
      const reason = loginRejection(cause);
      return new ImapError({
        message:
          reason === undefined
            ? `connect to ${account.host} failed: ${String(cause)}`
            : rejectedLoginMessage(account, reason),
      });
    },
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? retireClient(client) : Effect.void,
    ),
  );

export const closeClient = (client: WarmClient): Effect.Effect<void> =>
  Effect.suspend(() =>
    beginRetirement(client)
      ? Effect.promise(() => client.logout().catch(() => undefined))
      : Effect.void,
  );

export const withClientSearchDeadline = <Client, Result>(
  account: string,
  client: Client,
  search: (client: Client) => Effect.Effect<Result, MailError>,
  retire: Effect.Effect<void>,
): Effect.Effect<Result, MailError> =>
  Effect.gen(function* () {
    const retired = yield* Ref.make(false);
    const retireOnce = Ref.modify(retired, (alreadyRetired) => [
      alreadyRetired,
      true,
    ]).pipe(
      Effect.flatMap((alreadyRetired) =>
        alreadyRetired ? Effect.void : retire,
      ),
    );
    return yield* search(client).pipe(
      // The deadline may win while native IMAP promises or iterators continue.
      Effect.disconnect,
      Effect.timeoutFail({
        duration: Duration.seconds(accountSearchTimeoutSeconds),
        onTimeout: () =>
          new AccountSearchTimeoutError({
            account,
            message: `Search for ${account} did not complete within ${accountSearchTimeoutSeconds} seconds. Retry with this account alone or check the server.`,
          }),
      }),
      // Keep retirement outside disconnect so caller interruption also owns it.
      Effect.ensuring(retireOnce),
    );
  });
