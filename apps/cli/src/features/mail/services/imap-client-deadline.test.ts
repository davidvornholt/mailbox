import { describe, expect, it } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { withClientSearchDeadline } from './imap-client';
import { ControlledClient, lifecycleHit } from './imap-client.fixture';

const boundedFailure = (client: ControlledClient) =>
  Effect.flip(
    withClientSearchDeadline(
      'stalled@example.com',
      client,
      (candidate) => candidate.search(),
      Effect.sync(() => client.close()),
    ),
  );

describe('deadline client isolation', () => {
  it('retires a candidate stalled before acquisition returns and allows a replacement', async () => {
    const stalled = new ControlledClient(undefined);
    const replacement = new ControlledClient([lifecycleHit]);
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(boundedFailure(stalled));
      yield* TestClock.adjust('29999 millis');
      const beforeDeadline = {
        closeCalls: stalled.closeCalls,
        outstanding: stalled.outstanding,
        usable: stalled.usable,
      };
      yield* TestClock.adjust('1 millis');
      const error = yield* Fiber.join(fiber);
      const replacementResult = yield* withClientSearchDeadline(
        'stalled@example.com',
        replacement,
        (client) => client.search(),
        Effect.sync(() => replacement.close()),
      );
      return { beforeDeadline, error, replacementResult };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.beforeDeadline).toEqual({
      closeCalls: 0,
      outstanding: 1,
      usable: true,
    });
    expect(result.error).toMatchObject({
      _tag: 'AccountSearchTimeoutError',
      message: expect.stringContaining('30 seconds'),
    });
    expect(stalled).toMatchObject({
      usable: false,
      outstanding: 0,
      closeCalls: 1,
    });
    expect(result.replacementResult).toEqual([lifecycleHit]);
    expect(replacement.closeCalls).toBe(1);
  });

  it('retires repeated uninterruptible work when the outer caller is interrupted', async () => {
    const clients = [
      new ControlledClient(undefined),
      new ControlledClient(undefined),
    ];
    const program = Effect.gen(function* () {
      for (const client of clients) {
        const fiber = yield* Effect.forkChild(
          withClientSearchDeadline(
            'stalled@example.com',
            client,
            (candidate) => candidate.search(),
            Effect.sync(() => client.close()),
          ),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }
    });

    await Effect.runPromise(program);

    for (const client of clients) {
      expect(client).toMatchObject({
        usable: false,
        outstanding: 0,
        closeCalls: 1,
      });
    }
  });
});

describe('deadline client separation', () => {
  it('does not abort warm work or a staggered deadline client', async () => {
    const warm = new ControlledClient(undefined);
    const first = new ControlledClient(undefined);
    const second = new ControlledClient(undefined);
    const program = Effect.gen(function* () {
      const warmFiber = yield* Effect.forkChild(warm.search());
      const firstFiber = yield* Effect.forkChild(boundedFailure(first));
      yield* TestClock.adjust('10 seconds');
      const secondFiber = yield* Effect.forkChild(boundedFailure(second));
      yield* TestClock.adjust('20 seconds');
      const firstError = yield* Fiber.join(firstFiber);
      const beforeSecondDeadline = {
        secondCloseCalls: second.closeCalls,
        secondOutstanding: second.outstanding,
        warmCloseCalls: warm.closeCalls,
        warmOutstanding: warm.outstanding,
      };
      warm.complete([lifecycleHit]);
      const warmResult = yield* Fiber.join(warmFiber);
      yield* TestClock.adjust('10 seconds');
      const secondError = yield* Fiber.join(secondFiber);
      return {
        firstError,
        secondError,
        beforeSecondDeadline,
        warmResult,
      };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.firstError).toMatchObject({
      _tag: 'AccountSearchTimeoutError',
    });
    expect(result.beforeSecondDeadline).toEqual({
      secondCloseCalls: 0,
      secondOutstanding: 1,
      warmCloseCalls: 0,
      warmOutstanding: 1,
    });
    expect(result.warmResult).toEqual([lifecycleHit]);
    expect(result.secondError).toMatchObject({
      _tag: 'AccountSearchTimeoutError',
    });
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
    expect(warm.closeCalls).toBe(0);
  });
});
