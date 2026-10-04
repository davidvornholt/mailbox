import { describe, expect, it } from 'bun:test';
import { Deferred, Effect, Fiber, Ref } from 'effect';
import type { WarmClient } from './imap-client';
import { makeWarmClientCache } from './imap-warm-cache';

type FakeClient = WarmClient & { readonly id: string };

const fakeClient = (id: string): FakeClient => {
  const client: FakeClient = {
    id,
    usable: true,
    close: () => {
      client.usable = false;
    },
    logout: () => Promise.resolve(),
  };
  return client;
};

const countingGatedOpen =
  (opens: Ref.Ref<number>, gate: Deferred.Deferred<void>) => (email: string) =>
    Effect.gen(function* () {
      yield* Ref.update(opens, (count) => count + 1);
      yield* Deferred.await(gate);
      return fakeClient(email);
    });

const openGatedFor =
  (gatedEmail: string, gate: Deferred.Deferred<void>) => (email: string) =>
    Effect.gen(function* () {
      if (email === gatedEmail) {
        yield* Deferred.await(gate);
      }
      return fakeClient(email);
    });

describe('makeWarmClientCache', () => {
  it('opens exactly one client for two concurrent cold calls to the same account', async () => {
    const program = Effect.gen(function* () {
      const opens = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      const cache = yield* makeWarmClientCache(countingGatedOpen(opens, gate));
      const first = yield* Effect.forkChild(cache.clientFor('a@example.com'));
      const second = yield* Effect.forkChild(cache.clientFor('a@example.com'));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      const firstClient = yield* Fiber.join(first);
      const secondClient = yield* Fiber.join(second);
      const openCount = yield* Ref.get(opens);
      return { firstClient, secondClient, openCount };
    });

    const { firstClient, secondClient, openCount } =
      await Effect.runPromise(program);

    expect(openCount).toBe(1);
    expect(secondClient).toBe(firstClient);
  });

  it('opens different accounts independently while one open is in flight', async () => {
    const program = Effect.gen(function* () {
      const gateA = yield* Deferred.make<void>();
      const cache = yield* makeWarmClientCache(
        openGatedFor('a@example.com', gateA),
      );
      const fiberA = yield* Effect.forkChild(cache.clientFor('a@example.com'));
      yield* Effect.yieldNow;
      // Completes while account a's open still holds its own permit; a shared
      // lock would deadlock here.
      const clientB = yield* cache.clientFor('b@example.com');
      yield* Deferred.succeed(gateA, undefined);
      const clientA = yield* Fiber.join(fiberA);
      return { clientA, clientB };
    });

    const { clientA, clientB } = await Effect.runPromise(program);

    expect(clientA.id).toBe('a@example.com');
    expect(clientB.id).toBe('b@example.com');
    expect(clientA).not.toBe(clientB);
  });
});
