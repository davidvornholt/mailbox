import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import { decodeAccounts, findAccount } from './account';

const minimalAccount = {
  email: 'a@b.com',
  name: 'A',
  host: 'imap.b.com',
};

const decoded = (input: unknown) =>
  Result.getOrThrowWith(decodeAccounts(input), (error) => new Error(error));

const rejection = (input: unknown): string =>
  Result.match(decodeAccounts(input), {
    onFailure: (error) => error,
    onSuccess: () => 'accepted',
  });

describe('decodeAccounts', () => {
  it('applies implicit TLS and password defaults and uses the email as the login user', () => {
    expect(decoded({ accounts: [minimalAccount] })).toEqual([
      {
        ...minimalAccount,
        port: 993,
        secure: true,
        user: 'a@b.com',
        auth: 'password',
      },
    ]);
  });

  it('keeps an explicit port, security mode, login user, and auth method', () => {
    const explicit = {
      port: 143,
      secure: false,
      user: 'a',
      auth: 'microsoft',
    } as const;
    const [account] = decoded({
      accounts: [{ ...minimalAccount, ...explicit }],
    });
    expect(account).toMatchObject(explicit);
  });

  it('adds DAV settings that log in as the account user by default', () => {
    const [account] = decoded({
      accounts: [
        {
          ...minimalAccount,
          user: 'login',
          dav: { url: 'https://dav.b.com/' },
        },
      ],
    });
    expect(account?.dav).toEqual({ url: 'https://dav.b.com/', user: 'login' });
    const [plain] = decoded({ accounts: [minimalAccount] });
    expect(plain).not.toHaveProperty('dav');
  });

  it("adds Graph settings that use pim's app unless client-id replaces it", () => {
    const [account, own] = decoded({
      accounts: [
        { ...minimalAccount, graph: {} },
        {
          ...minimalAccount,
          email: 'c@example.com',
          graph: { 'client-id': '00000000-0000-4000-8000-000000000002' },
        },
      ],
    });
    expect(account?.graph).toEqual({
      clientId: '161e31aa-5a5e-4f0f-a4c5-9660cf121f18',
    });
    expect(own?.graph).toEqual({
      clientId: '00000000-0000-4000-8000-000000000002',
    });
    const [plain] = decoded({ accounts: [minimalAccount] });
    expect(plain).not.toHaveProperty('graph');
  });

  it('rejects an empty accounts list', () => {
    expect(rejection({ accounts: [] })).not.toBe('accepted');
  });

  it('rejects account emails that differ only by case', () => {
    expect(
      rejection({
        accounts: [minimalAccount, { ...minimalAccount, email: 'A@B.com' }],
      }),
    ).toContain('account emails must be unique');
  });

  it.each([
    ['a missing host', { email: 'a@b.com', name: 'A' }, 'host'],
    ['a misspelled key', { ...minimalAccount, hots: 'x' }, 'hots'],
    ['an out-of-range port', { ...minimalAccount, port: 70_000 }, 'port'],
    ['an unknown auth method', { ...minimalAccount, auth: 'oauth' }, 'auth'],
    [
      'a plain-http DAV url',
      { ...minimalAccount, dav: { url: 'http://dav.b.com/' } },
      'must be an https URL',
    ],
    [
      'a misspelled DAV key',
      { ...minimalAccount, dav: { url: 'https://dav.b.com/', usr: 'x' } },
      'usr',
    ],
    [
      'an unknown Graph key',
      { ...minimalAccount, graph: { tenant: 'x' } },
      'tenant',
    ],
    [
      'an empty Graph client-id',
      { ...minimalAccount, graph: { 'client-id': '' } },
      'client-id',
    ],
  ])('rejects %s and names the field', (_case, account, field) => {
    expect(rejection({ accounts: [account] })).toContain(field);
  });
});

describe('findAccount', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const accounts = decoded({ accounts: [minimalAccount] });
    expect(findAccount(accounts, ' A@B.COM ')?.email).toBe('a@b.com');
    expect(findAccount(accounts, 'other@b.com')).toBeUndefined();
  });
});
