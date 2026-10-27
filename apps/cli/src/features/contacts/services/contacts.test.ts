import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import { Dav } from '../../../shared/dav/dav';
import {
  davResponse,
  discoveryRoutes,
  fakeDavServer,
  multistatus,
} from '../../../shared/dav/dav-server.fixture';
import type { ContactSummary } from '../schemas/contacts';
import { accountContacts, matchesContact } from './contacts';

const ana: ContactSummary = {
  account: 'me@example.com',
  addressBook: 'Contacts',
  href: '/a.vcf',
  name: 'Ana Boss',
  organization: 'Example GmbH',
  emails: ['ana@example.com'],
  phones: ['+49 (170) 123-4567'],
};

describe('matchesContact', () => {
  it.each(['ana', 'BOSS', 'example gmbh', 'ana@example', '1701234', '170 123'])(
    'matches %p',
    (query) => {
      expect(matchesContact(ana, query)).toBe(true);
    },
  );

  it.each(['bo@example.com', '17', 'nobody'])('does not match %p', (query) => {
    expect(matchesContact(ana, query)).toBe(false);
  });
});

const account: Account = {
  email: 'me@example.com',
  name: 'Me',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
  auth: 'password',
  dav: { url: 'https://dav.example.com/', user: 'me-dav' },
};

const vcard = (...lines: ReadonlyArray<string>) =>
  ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\n');

describe('accountContacts', () => {
  it('lists matching contacts and reports unreadable vCards', async () => {
    const { client, requests } = fakeDavServer({
      ...discoveryRoutes,
      'PROPFIND /addressbooks/me/': {
        body: multistatus(
          davResponse(
            '/addressbooks/me/',
            '<d:resourcetype><d:collection/></d:resourcetype>',
          ),
          davResponse(
            '/addressbooks/me/contacts/',
            '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname>',
          ),
        ),
      },
      'REPORT /addressbooks/me/contacts/': {
        body: multistatus(
          davResponse(
            '/addressbooks/me/contacts/a.vcf',
            `<card:address-data>${vcard('FN:Ana Boss', 'EMAIL:ana@example.com')}</card:address-data>`,
          ),
          davResponse(
            '/addressbooks/me/contacts/b.vcf',
            `<card:address-data>${vcard('FN:Bo Other')}</card:address-data>`,
          ),
          davResponse(
            '/addressbooks/me/contacts/c.vcf',
            '<card:address-data>garbage</card:address-data>',
          ),
          davResponse(
            '/addressbooks/me/contacts/d.vcf',
            `<card:address-data>${vcard('FN:Ana Desk', 'TEL;TYPE=work:+49 30 1234')}</card:address-data>`,
          ),
          davResponse(
            '/addressbooks/me/contacts/e.vcf',
            `<card:address-data>${vcard('FN:Ana Broken', 'TEL;VALUE=utc-offset:garbage')}</card:address-data>`,
          ),
        ),
      },
    });
    const dav = Dav.of({
      client: () => Effect.succeed(client),
      clientWith: () => Effect.succeed(client),
    });
    const result = await Effect.runPromise(
      accountContacts(account, { text: 'ana' }).pipe(
        Effect.provideService(Dav, dav),
      ),
    );
    expect(result.contacts).toEqual([
      {
        account: 'me@example.com',
        addressBook: 'Contacts',
        href: '/addressbooks/me/contacts/a.vcf',
        name: 'Ana Boss',
        emails: ['ana@example.com'],
        phones: [],
      },
      {
        account: 'me@example.com',
        addressBook: 'Contacts',
        href: '/addressbooks/me/contacts/d.vcf',
        name: 'Ana Desk',
        emails: [],
        phones: ['+49 30 1234'],
      },
    ]);
    expect(result.unreadable).toEqual([
      {
        account: 'me@example.com',
        errorTag: 'ContactDataError',
        message: expect.stringContaining('/addressbooks/me/contacts/c.vcf'),
      },
      {
        account: 'me@example.com',
        errorTag: 'ContactDataError',
        message:
          'Could not read /addressbooks/me/contacts/e.vcf: Error: Could not extract integer from "ar"',
      },
    ]);
    expect(requests.at(-1)?.body).toContain('<card:filter/>');
  });
});
