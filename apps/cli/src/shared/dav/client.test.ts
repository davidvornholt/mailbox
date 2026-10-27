import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { davLogin, fakeDavServer } from './dav-server.fixture';
import { discoverPrincipal } from './discovery';

const failureOf = <E>(effect: Effect.Effect<unknown, E>) =>
  Effect.runPromise(Effect.flip(effect));

describe('makeDavClient', () => {
  it('logs in with HTTP Basic authentication', async () => {
    const { client, requests } = fakeDavServer({
      'GET /item.ics': { status: 200, body: 'data' },
    });
    await Effect.runPromise(client.send({ method: 'GET', href: '/item.ics' }));
    expect(requests[0]?.authorization).toBe(
      `Basic ${btoa(`${davLogin.user}:${davLogin.password}`)}`,
    );
  });

  it.each([
    'https://other.example.com/item.ics',
    'http://dav.example.com/item.ics',
    '//other.example.com/item.ics',
  ])('refuses to send the password to %s', async (href) => {
    const { client, requests } = fakeDavServer({});
    const error = await failureOf(client.send({ method: 'GET', href }));
    expect(error._tag).toBe('DavError');
    expect(error.message).toContain("is not on me@example.com's DAV server");
    expect(requests).toHaveLength(0);
  });

  it('reports a rejected login with the command that fixes it', async () => {
    const { client } = fakeDavServer({ 'GET /item.ics': { status: 401 } });
    const error = await failureOf(
      client.send({ method: 'GET', href: '/item.ics' }),
    );
    expect(error._tag).toBe('DavAuthError');
    expect(error.message).toContain(
      'pim login --account me@example.com --only dav',
    );
  });

  it('reports a missing resource as not found', async () => {
    const { client } = fakeDavServer({});
    const error = await failureOf(
      client.send({ method: 'GET', href: '/gone.ics' }),
    );
    expect(error._tag).toBe('DavNotFoundError');
  });

  it('reports a forbidden request without the response body', async () => {
    const { client } = fakeDavServer({
      'GET /item.ics': { status: 403, body: '<html>stack trace</html>' },
    });
    const error = await failureOf(
      client.send({ method: 'GET', href: '/item.ics' }),
    );
    expect(error._tag).toBe('DavError');
    expect(error.message).toContain('the server forbids it');
    expect(error.message).not.toContain('stack trace');
  });

  it('rejects a reply that is not a multistatus', async () => {
    const { client } = fakeDavServer({
      'PROPFIND /': { body: '<html>login page</html>' },
    });
    const error = await failureOf(
      client.propfind('/', '0', '<d:displayname/>'),
    );
    expect(error.message).toContain('did not answer with a DAV multistatus');
  });
});

describe('discoverPrincipal', () => {
  it('finds the homes and the mail addresses of the signed-in user', async () => {
    const { client, requests } = fakeDavServer({
      'PROPFIND /': {
        body: `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/principals/me/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
      },
      'PROPFIND /principals/me/': {
        body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/calendars/me/</d:href></cal:calendar-home-set><cal:calendar-user-address-set><d:href>MAILTO:me%2Bwork@example.com</d:href><d:href>/principals/me/</d:href></cal:calendar-user-address-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`,
      },
    });
    const principal = await Effect.runPromise(discoverPrincipal(client));
    expect(principal).toEqual({
      href: '/principals/me/',
      displayName: undefined,
      calendarHome: '/calendars/me/',
      addressBookHome: undefined,
      addresses: ['me+work@example.com'],
    });
    expect(requests.map(({ method, depth }) => `${method} ${depth}`)).toEqual([
      'PROPFIND 0',
      'PROPFIND 0',
    ]);
  });
});
