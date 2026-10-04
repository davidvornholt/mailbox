import { describe, expect, it } from 'bun:test';
import { Effect, Fiber } from 'effect';
import type { ImapFlow } from 'imapflow';
import type { Account } from '../schemas/account';
import { connectClient, makeClient } from './imap-client';

const account: Account = {
  email: 'me@example.com',
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
  auth: 'password',
};

type ImapFlowWithErrorEmitter = ImapFlow & {
  emitError: (error: Error & { code?: string }) => void;
};

describe('makeClient', () => {
  it('closes every constructed client when ImapFlow emits a socket timeout', () => {
    const client = makeClient(account, { pass: 'password' });
    client.usable = true;
    const timeout = Object.assign(new Error('Socket timeout'), {
      code: 'ETIMEOUT',
    });

    expect(() =>
      (client as ImapFlowWithErrorEmitter).emitError(timeout),
    ).not.toThrow();
    expect(client.usable).toBeFalse();
    expect(makeClient(account, { pass: 'password' })).not.toBe(client);
  });

  it('closes a constructed candidate when connection fails', async () => {
    const client = makeClient(account, { pass: 'password' });
    let closeCalls = 0;
    client.connect = () => Promise.reject(new Error('connect failed'));
    client.close = () => {
      closeCalls += 1;
    };

    const error = await Effect.runPromise(
      Effect.flip(connectClient(client, account)),
    );

    expect(error).toMatchObject({ _tag: 'ImapError' });
    expect(closeCalls).toBe(1);
  });

  it('closes a constructed candidate when connection is interrupted', async () => {
    const client = makeClient(account, { pass: 'password' });
    let closeCalls = 0;
    client.connect = () => new Promise<void>(() => undefined);
    client.close = () => {
      closeCalls += 1;
    };
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(connectClient(client, account));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    });

    await Effect.runPromise(program);

    expect(closeCalls).toBe(1);
  });
});

describe('connectClient', () => {
  // imapflow rejects a failed login with this shape.
  const rejectedLogin = (reply: string) =>
    Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      response: reply,
    });

  const connectFailure = async (target: Account, cause: unknown) => {
    const client = makeClient(target, { pass: 'password' });
    client.connect = () => Promise.reject(cause);
    client.close = () => undefined;
    const error = await Effect.runPromise(
      Effect.flip(connectClient(client, target)),
    );
    return error.message;
  };

  it("explains a rejected password with the server's reason", async () => {
    expect(
      await connectFailure(
        account,
        rejectedLogin(
          '3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
        ),
      ),
    ).toBe(
      'imap.example.com rejected the password: Invalid credentials (Failure). Check the password; some providers, such as Gmail, require an app password.',
    );
  });

  it('explains a rejected Microsoft sign-in', async () => {
    expect(
      await connectFailure(
        { ...account, auth: 'microsoft' },
        rejectedLogin('3 NO AUTHENTICATE failed.'),
      ),
    ).toBe(
      'imap.example.com rejected the Microsoft sign-in: AUTHENTICATE failed. Check that the sign-in used me@example.com and that the mailbox allows IMAP.',
    );
  });

  it('keeps the cause of other connection failures', async () => {
    expect(
      await connectFailure(account, new Error('getaddrinfo ENOTFOUND')),
    ).toBe('connect to imap.example.com failed: Error: getaddrinfo ENOTFOUND');
  });
});
