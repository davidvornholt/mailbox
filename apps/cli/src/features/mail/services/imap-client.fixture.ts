import { Effect } from 'effect';
import { ImapError } from '../errors/errors';
import { mailboxHit } from './account-search.fixture';
import type { MailboxSearchHit } from './imap-search';

export class ControlledClient {
  usable = true;
  outstanding = 0;
  closeCalls = 0;
  readonly result: ReadonlyArray<MailboxSearchHit> | undefined;
  readonly #waiters = new Set<
    (effect: Effect.Effect<ReadonlyArray<MailboxSearchHit>, ImapError>) => void
  >();

  constructor(result: ReadonlyArray<MailboxSearchHit> | undefined) {
    this.result = result;
  }

  search = (): Effect.Effect<ReadonlyArray<MailboxSearchHit>, ImapError> => {
    if (this.result !== undefined) {
      return Effect.succeed(this.result);
    }
    return Effect.uninterruptible(
      Effect.callback((resume) => {
        this.outstanding += 1;
        this.#waiters.add(resume);
      }),
    );
  };

  close = (): void => {
    this.closeCalls += 1;
    this.usable = false;
    for (const resume of this.#waiters) {
      resume(Effect.fail(new ImapError({ message: 'retired stalled client' })));
    }
    this.#waiters.clear();
    this.outstanding = 0;
  };

  complete = (result: ReadonlyArray<MailboxSearchHit>): void => {
    for (const resume of this.#waiters) {
      resume(Effect.succeed(result));
    }
    this.#waiters.clear();
    this.outstanding = 0;
  };

  logout = (): Promise<void> => {
    this.close();
    return Promise.resolve();
  };
}

export const lifecycleHit = mailboxHit(
  1,
  '<healthy@example.com>',
  '2026-07-16T08:00:00Z',
);
