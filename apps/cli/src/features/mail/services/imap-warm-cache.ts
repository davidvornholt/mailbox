import { Effect, Ref, Semaphore } from 'effect';
import { retireClient, type WarmClient } from './imap-client';

type WarmClientCache<Client extends WarmClient, OpenError> = {
  readonly clientFor: (email: string) => Effect.Effect<Client, OpenError>;
  readonly closeAll: Effect.Effect<void>;
};

// Warm per-account client cache with single-flight cold opens: a Semaphore(1)
// per account gates `open`, so two concurrent cold `clientFor` calls for the
// same account produce exactly one connected client (the second waiter
// re-checks the cache inside the permit and reuses the winner), while
// different accounts open concurrently. A stalled opener cannot hold the
// permit forever because makeClient's 60s socketTimeout errors the connect,
// which fails `open` and releases the permit.
export const makeWarmClientCache = <Client extends WarmClient, OpenError>(
  open: (email: string) => Effect.Effect<Client, OpenError>,
): Effect.Effect<WarmClientCache<Client, OpenError>> =>
  Effect.gen(function* () {
    const clients = yield* Ref.make<ReadonlyMap<string, Client>>(new Map());
    const openLocks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(
      new Map(),
    );
    const lockFor = (email: string) =>
      Ref.modify(openLocks, (locks) => {
        const existing = locks.get(email);
        if (existing !== undefined) {
          return [existing, locks] as const;
        }
        const created = Semaphore.makeUnsafe(1);
        return [created, new Map(locks).set(email, created)] as const;
      });
    const cachedUsable = (email: string) =>
      Ref.get(clients).pipe(
        Effect.map((map) => {
          const existing = map.get(email);
          return existing?.usable === true ? existing : undefined;
        }),
      );
    const openUnderLock = (email: string) =>
      lockFor(email).pipe(
        Effect.flatMap((lock) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const winner = yield* cachedUsable(email);
              if (winner !== undefined) {
                return winner;
              }
              const client = yield* open(email);
              yield* Ref.update(clients, (map) =>
                new Map(map).set(email, client),
              );
              return client;
            }),
          ),
        ),
      );
    const clientFor = (email: string) =>
      cachedUsable(email).pipe(
        Effect.flatMap((cached) =>
          cached === undefined ? openUnderLock(email) : Effect.succeed(cached),
        ),
      );
    const closeAll = Ref.get(clients).pipe(
      Effect.flatMap((map) =>
        Effect.forEach([...map.values()], retireClient, { discard: true }),
      ),
    );
    return { clientFor, closeAll } as const;
  });
