import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { resolveSearchOptions } from './search-options';

const base = { limit: 20, query: 'invoice' } as const;

describe('resolveSearchOptions', () => {
  it('defaults to all-mail scope when neither scope nor folder is supplied', async () => {
    await expect(
      Effect.runPromise(resolveSearchOptions(base)),
    ).resolves.toEqual({
      ...base,
      scope: 'all',
    });
  });

  it.each([
    ['subtree', 'Projects'],
    ['folder', 'INBOX'],
  ] as const)('accepts an explicit %s search', async (scope, folder) => {
    await expect(
      Effect.runPromise(resolveSearchOptions({ ...base, scope, folder })),
    ).resolves.toEqual({ ...base, scope, folder });
  });

  it('accepts a calendar since date', async () => {
    await expect(
      Effect.runPromise(resolveSearchOptions({ ...base, since: '2024-02-29' })),
    ).resolves.toMatchObject({ since: '2024-02-29' });
  });

  it.each(['2023-02-29', '2026-13-01', 'last week', '2026-1-5'])(
    'rejects the since value %p',
    async (since) => {
      const error = await Effect.runPromise(
        Effect.flip(resolveSearchOptions({ ...base, since })),
      );
      expect(error.message).toContain('use YYYY-MM-DD');
    },
  );

  it.each([
    [
      'a folder combined with all-mail scope',
      { scope: 'all', folder: 'INBOX' },
    ],
    ['a folder without an explicit folder-based scope', { folder: 'INBOX' }],
    ['a folder-based scope without a folder', { scope: 'subtree' }],
  ] as const)('rejects %s', async (_case, input) => {
    const error = await Effect.runPromise(
      Effect.flip(resolveSearchOptions({ ...base, ...input })),
    );
    expect(error._tag).toBe('SearchInputError');
  });
});
