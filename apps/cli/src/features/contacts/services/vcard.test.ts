import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { contactDetail, displayName, parseVCard } from './vcard';

const card = (...lines: ReadonlyArray<string>) =>
  Effect.runSync(
    parseVCard(
      '/addressbooks/me/contacts/a.vcf',
      ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n'),
    ),
  );

describe('parseVCard', () => {
  it('rejects data that is not a vCard', () => {
    const error = Effect.runSync(
      Effect.flip(
        parseVCard('/a.vcf', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'),
      ),
    );
    expect(error._tag).toBe('ContactDataError');
    expect(error.message).toContain('holds no contact');
  });
});

describe('displayName', () => {
  it.each([
    [['FN:Ana Boss', 'N:Boss;Ana;;;'], 'Ana Boss'],
    [['N:Boss;Ana;Maria;Dr.;'], 'Dr. Ana Maria Boss'],
    [['ORG:Example GmbH;Sales'], 'Example GmbH, Sales'],
    [['ORG:Example\\; Partner'], 'Example; Partner'],
    [['EMAIL:ana@example.com'], 'ana@example.com'],
  ])('names a contact from %p', (lines, name) => {
    expect(displayName(card(...lines))).toBe(name);
  });
});

describe('contactDetail', () => {
  it('reads the fields a contact lookup needs', () => {
    const detail = contactDetail(
      card(
        'UID:ana@example.com',
        'FN:Ana Boss',
        'N:Boss;Ana;;;',
        'NICKNAME:Annie,AB',
        'ORG:Example GmbH',
        'TITLE:Head of sales',
        'EMAIL;TYPE=INTERNET,WORK,pref:ana@example.com',
        'EMAIL;TYPE=HOME:ana@home.example',
        'TEL;TYPE=CELL:+49 170 1234567',
        'ADR;TYPE=WORK:;;Hauptstr. 1;Berlin;;10115;Germany',
        'BDAY:1980-04-02',
        'URL:https://example.com',
        'CATEGORIES:Clients,VIP',
        'NOTE:Prefers calls',
      ),
      {
        account: 'me@example.com',
        href: '/addressbooks/me/contacts/a.vcf',
        etag: '"c1"',
      },
    );
    expect(detail).toEqual({
      account: 'me@example.com',
      href: '/addressbooks/me/contacts/a.vcf',
      etag: '"c1"',
      uid: 'ana@example.com',
      name: 'Ana Boss',
      familyName: 'Boss',
      givenName: 'Ana',
      nickname: 'Annie, AB',
      organization: 'Example GmbH',
      title: 'Head of sales',
      emails: [
        { value: 'ana@example.com', type: 'work' },
        { value: 'ana@home.example', type: 'home' },
      ],
      phones: [{ value: '+49 170 1234567', type: 'cell' }],
      addresses: [
        {
          type: 'work',
          street: 'Hauptstr. 1',
          locality: 'Berlin',
          postalCode: '10115',
          country: 'Germany',
        },
      ],
      birthday: '1980-04-02',
      urls: ['https://example.com'],
      categories: ['Clients', 'VIP'],
      note: 'Prefers calls',
    });
  });

  it('strips URI schemes from vCard 4 emails and phones', () => {
    const detail = contactDetail(
      card(
        'FN:Bo',
        'EMAIL:mailto:bo@example.com',
        'TEL;VALUE=uri:tel:+4930123',
      ),
      { account: 'me@example.com', href: '/b.vcf', etag: undefined },
    );
    expect(detail.emails).toEqual([{ value: 'bo@example.com' }]);
    expect(detail.phones).toEqual([{ value: '+4930123' }]);
  });
});
