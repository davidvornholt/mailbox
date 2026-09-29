import { describe, expect, it } from 'bun:test';
import {
  ImapError,
  KeyringError,
  MissingCredentialsError,
  OAuthError,
} from '../errors/errors';
import { statusFromError } from './status';

describe('statusFromError', () => {
  it('reports missing keyring credentials as no-credentials with a login hint', () => {
    const status = statusFromError(
      'a@b.com',
      new MissingCredentialsError({ account: 'a@b.com', message: 'none' }),
    );
    expect(status.state).toBe('no-credentials');
    expect(status.ok).toBe(false);
    expect(status.message).toContain('mailbox login --account a@b.com');
  });

  it.each([
    ['a connection or login failure', new ImapError({ message: 'Rejected' })],
    ['a rejected Microsoft sign-in', new OAuthError({ message: 'Rejected' })],
  ])('reports %s as unauthenticated with the cause', (_case, error) => {
    const status = statusFromError('a@b.com', error);
    expect(status.state).toBe('unauthenticated');
    expect(status.message).toBe('Rejected');
  });

  it('reports other failures as a generic error', () => {
    const status = statusFromError(
      'a@b.com',
      new KeyringError({ message: 'keyring locked' }),
    );
    expect(status.state).toBe('error');
    expect(status.ok).toBe(false);
  });
});
