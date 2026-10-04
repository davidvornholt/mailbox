import { describe, expect, it } from 'bun:test';
import { Either } from 'effect';
import { decodeAccounts, findAccount } from './account';

const minimalAccount = {
  email: 'a@b.com',
  name: 'A',
  host: 'imap.b.com',
};

const decoded = (input: unknown) =>
  Either.getOrThrowWith(decodeAccounts(input), (error) => new Error(error));

const rejection = (input: unknown): string =>
  Either.match(decodeAccounts(input), {
    onLeft: (error) => error,
    onRight: () => 'accepted',
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
