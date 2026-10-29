import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { DavError } from '../errors/dav';
import type { Account } from './account';
import { acrossAccounts } from './across';

const accountFor = (email: string): Account => ({
  email,
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: email,
  auth: 'password',
  dav: { url: 'https://dav.example.com/', user: email },
});

const run = (account: Account) =>
  account.email.startsWith('bad')
    ? Effect.fail(new DavError({ message: `${account.email} is down` }))
    : Effect.succeed(account.email);

describe('acrossAccounts', () => {
  it('fails with the error of a single account', async () => {
    const error = await Effect.runPromise(
      Effect.flip(acrossAccounts([accountFor('bad@example.com')], run)),
    );
    expect(error).toEqual(new DavError({ message: 'bad@example.com is down' }));
  });

  it('lists failed accounts beside the others', async () => {
    const result = await Effect.runPromise(
      acrossAccounts(
        [accountFor('a@example.com'), accountFor('bad@example.com')],
        run,
      ),
    );
    expect(result).toEqual({
      results: ['a@example.com'],
      failures: [
        {
          account: 'bad@example.com',
          errorTag: 'DavError',
          message: 'bad@example.com is down',
        },
      ],
    });
  });

  it('fails when every account failed', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        acrossAccounts(
          [accountFor('bad1@example.com'), accountFor('bad2@example.com')],
          run,
        ),
      ),
    );
    expect(error._tag).toBe('AccountsError');
    expect(error.message).toContain(
      'bad2@example.com: bad2@example.com is down',
    );
  });
});
