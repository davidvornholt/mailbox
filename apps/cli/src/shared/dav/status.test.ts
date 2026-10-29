import { describe, expect, it } from 'bun:test';
import { MissingCredentialsError } from '../errors/accounts';
import { DavAuthError, DavError } from '../errors/dav';
import { davStatusFromError } from './status';

describe('davStatusFromError', () => {
  it('asks for a DAV login when the keyring has no password', () => {
    const status = davStatusFromError(
      'a@example.com',
      new MissingCredentialsError({
        account: 'a@example.com',
        message: 'none',
      }),
    );
    expect(status).toMatchObject({
      service: 'dav',
      ok: false,
      state: 'no-credentials',
    });
    expect(status.message).toContain(
      'pim login --account a@example.com --only dav',
    );
  });

  it('reports a rejected login as unauthenticated', () => {
    const status = davStatusFromError(
      'a@example.com',
      new DavAuthError({ account: 'a@example.com', message: 'rejected' }),
    );
    expect(status).toMatchObject({
      state: 'unauthenticated',
      message: 'rejected',
    });
  });

  it('reports other failures as errors', () => {
    expect(
      davStatusFromError('a@example.com', new DavError({ message: 'down' }))
        .state,
    ).toBe('error');
  });
});
