import { describe, expect, it } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { searchWithDedicatedClient } from './imap';
import { ControlledClient, lifecycleHit } from './imap-client.fixture';

describe('searchWithDedicatedClient', () => {
  it('constructs and retires a client distinct from outstanding warm work', async () => {
    const warm = new ControlledClient(undefined);
    const created: Array<ControlledClient> = [];
    const program = Effect.gen(function* () {
      const warmFiber = yield* Effect.forkChild(warm.search());
      const boundedFiber = yield* Effect.forkChild(
        Effect.flip(
          searchWithDedicatedClient(
            'stalled@example.com',
            () => {
              const client = new ControlledClient(undefined);
              created.push(client);
              return client;
            },
            () => Effect.void,
            (client) => client.search(),
          ),
        ),
      );
      yield* TestClock.adjust('30 seconds');
      const boundedError = yield* Fiber.join(boundedFiber);
      const warmBeforeCompletion = {
        closeCalls: warm.closeCalls,
        outstanding: warm.outstanding,
        usable: warm.usable,
      };
      warm.complete([lifecycleHit]);
      const warmResult = yield* Fiber.join(warmFiber);
      return { boundedError, warmBeforeCompletion, warmResult };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    const [bounded] = created;
    expect(bounded).not.toBe(warm);
    expect(bounded).toMatchObject({
      closeCalls: 1,
      outstanding: 0,
      usable: false,
    });
    expect(result.boundedError).toMatchObject({
      _tag: 'AccountSearchTimeoutError',
    });
    expect(result.warmBeforeCompletion).toEqual({
      closeCalls: 0,
      outstanding: 1,
      usable: true,
    });
    expect(result.warmResult).toEqual([lifecycleHit]);
  });

  it('bounds activation before mailbox search starts', async () => {
    const client = new ControlledClient(undefined);
    let searchCalls = 0;
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          searchWithDedicatedClient(
            'stalled@example.com',
            () => client,
            (candidate) => candidate.search().pipe(Effect.asVoid),
            () => {
              searchCalls += 1;
              return Effect.succeed([lifecycleHit]);
            },
          ),
        ),
      );
      yield* TestClock.adjust('29999 millis');
      const beforeDeadline = {
        closeCalls: client.closeCalls,
        outstanding: client.outstanding,
      };
      yield* TestClock.adjust('1 millis');
      const error = yield* Fiber.join(fiber);
      return { beforeDeadline, error };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.beforeDeadline).toEqual({
      closeCalls: 0,
      outstanding: 1,
    });
    expect(result.error).toMatchObject({
      _tag: 'AccountSearchTimeoutError',
    });
    expect(searchCalls).toBe(0);
    expect(client.closeCalls).toBe(1);
  });
});
