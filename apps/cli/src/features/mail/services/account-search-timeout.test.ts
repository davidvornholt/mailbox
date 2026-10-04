import { describe, expect, it } from 'bun:test';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { searchAllAccounts } from './account-search';
import { searchOptions } from './account-search.fixture';
import { withClientSearchDeadline } from './imap-client';
import { ControlledClient, lifecycleHit } from './imap-client.fixture';

describe('searchAllAccounts timeout retirement', () => {
  it('retires repeated stalled clients before returning and uses a replacement for the next operation', async () => {
    const stalledClients: Array<ControlledClient> = [];
    let stalledOpenings = 0;
    const program = Effect.gen(function* () {
      const boundedSearch = (account: string) =>
        Effect.suspend(() => {
          const isStalledAccount = account === 'stalled@example.com';
          const client = new ControlledClient(
            !isStalledAccount || stalledOpenings >= 2
              ? [lifecycleHit]
              : undefined,
          );
          if (isStalledAccount) {
            stalledOpenings += 1;
            stalledClients.push(client);
          }
          return withClientSearchDeadline(
            account,
            client,
            (candidate) => candidate.search(),
            Effect.sync(() => client.close()),
          );
        });

      const results = yield* Effect.forEach([0, 1], () =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            searchAllAccounts(
              ['healthy@example.com', 'stalled@example.com'],
              searchOptions,
              boundedSearch,
            ),
          );
          yield* TestClock.adjust('30 seconds');
          return yield* Fiber.join(fiber);
        }),
      );
      const laterHits = yield* boundedSearch('stalled@example.com');
      return { results, laterHits };
    });

    const { results, laterHits } = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    const [firstStalled, secondStalled, replacement] = stalledClients;
    expect(
      results.every(
        (result) =>
          result.hits[0]?.account === 'healthy@example.com' &&
          result.failures[0]?.errorTag === 'AccountSearchTimeoutError',
      ),
    ).toBeTrue();
    for (const stalled of [firstStalled, secondStalled]) {
      expect(stalled).toMatchObject({
        usable: false,
        outstanding: 0,
        closeCalls: 1,
      });
    }
    expect(replacement).not.toBe(firstStalled);
    expect(replacement).not.toBe(secondStalled);
    expect(replacement?.closeCalls).toBe(1);
    expect(laterHits).toEqual([lifecycleHit]);
  });
});

describe('searchAllAccounts all-stalled lifecycle', () => {
  it('retires every stalled client when all accounts time out', async () => {
    const opened: Array<ControlledClient> = [];
    const program = Effect.gen(function* () {
      const boundedSearch = (account: string) =>
        Effect.suspend(() => {
          const client = new ControlledClient(undefined);
          opened.push(client);
          return withClientSearchDeadline(
            account,
            client,
            (candidate) => candidate.search(),
            Effect.sync(() => client.close()),
          );
        });
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          searchAllAccounts(
            ['first@example.com', 'second@example.com'],
            searchOptions,
            boundedSearch,
          ),
        ),
      );
      yield* TestClock.adjust('30 seconds');
      return yield* Fiber.join(fiber);
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toMatchObject({ _tag: 'SearchAccountsError' });
    expect(result.message).toContain('first@example.com');
    expect(result.message).toContain('second@example.com');
    expect(opened).toHaveLength(2);
    expect(
      opened.every(
        (client) =>
          !client.usable && client.outstanding === 0 && client.closeCalls === 1,
      ),
    ).toBeTrue();
  });
});
