import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import {
  applyContactChanges,
  type ContactChanges,
  newVCard,
} from './vcard-write';

const now = Date.UTC(2026, 9, 28, 9, 15, 0, 123);

const lines = (text: string) => text.trimEnd().split('\r\n');

const cardOf = (...properties: ReadonlyArray<string>) =>
  ['BEGIN:VCARD', 'VERSION:3.0', ...properties, 'END:VCARD', ''].join('\r\n');

const noChanges: ContactChanges = {
  addEmails: [],
  removeEmails: [],
  addPhones: [],
  removePhones: [],
};

// The vCard lines after the changes, or the reason they were refused.
const changed = (
  vcard: string,
  changes: Partial<ContactChanges>,
): ReadonlyArray<string> | string => {
  const applied = applyContactChanges(vcard, { ...noChanges, ...changes }, now);
  return Result.isSuccess(applied) ? lines(applied.success) : applied.failure;
};

describe('newVCard', () => {
  it('writes a vCard 3.0 with the name built from its parts', () => {
    const text = newVCard(
      {
        uid: 'u1',
        givenName: 'Ada',
        familyName: 'Lovelace',
        organization: 'Analytical; Engines',
        emails: ['ada@example.org', 'ADA@example.org'],
        phones: ['+49 170 1234567'],
      },
      now,
    );
    expect(lines(text)).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:-//pim//EN',
      'UID:u1',
      'N:Lovelace;Ada;;;',
      'ORG:Analytical\\; Engines',
      'FN:Ada Lovelace',
      'EMAIL:ada@example.org',
      'TEL:+49 170 1234567',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('prefers the given name to show', () => {
    const text = newVCard(
      { uid: 'u1', name: 'Dr. Ada', emails: [], phones: [] },
      now,
    );
    expect(lines(text)).toContain('FN:Dr. Ada');
  });
});

const removedFields = /^(?:ORG|TITLE|NOTE)/u;

const appleCard = cardOf(
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;;;',
  'item1.EMAIL;type=INTERNET;type=pref:ada@example.org',
  'item1.X-ABLabel:_$!<Work>!$_',
  'item2.EMAIL:other@example.org',
  'item2.X-ABLabel:home',
  'TEL;type=CELL:+49 (170) 123-4567',
  'REV:20200101T000000Z',
);

describe('applyContactChanges', () => {
  it('removes values with their labels and keeps other lines as stored', () => {
    expect(
      changed(appleCard, {
        addEmails: ['new@example.org', 'OTHER@example.org'],
        removeEmails: ['ADA@example.org'],
        removePhones: ['+491701234567'],
      }),
    ).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ada Lovelace',
      'N:Lovelace;Ada;;;',
      'item2.EMAIL:other@example.org',
      'item2.X-ABLabel:home',
      'EMAIL:new@example.org',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('keeps properties it does not change as stored', () => {
    const v4 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Cy',
      'ORG:Solo\\;Org',
      'TEL;VALUE=uri;TYPE="voice,cell":tel:+49-170-1234567',
      'BDAY:--0415',
      `NOTE:${'long '.repeat(20)}`,
      ' folded',
      'END:VCARD',
    ];
    expect(changed(v4.join('\n'), { title: 'Analyst' })).toEqual([
      ...v4.slice(0, -1),
      'TITLE:Analyst',
      'REV:20261028T091500Z',
      'END:VCARD',
    ]);
  });

  it('keeps the name in step with the parts it was built from', () => {
    expect(changed(appleCard, { familyName: 'King' })).toEqual(
      expect.arrayContaining(['FN:Ada King', 'N:King;Ada;;;']),
    );
  });

  it('keeps a name that was not built from the parts', () => {
    const card = cardOf('FN:Countess', 'N:Lovelace;Ada;;Lady;');
    expect(changed(card, { givenName: 'Augusta' })).toEqual(
      expect.arrayContaining(['FN:Countess', 'N:Lovelace;Augusta;;Lady;']),
    );
    expect(changed(card, { name: 'Ada' })).toContain('FN:Ada');
  });

  it('removes text fields given as empty', () => {
    const card = cardOf('FN:Ada', 'ORG:Engines', 'TITLE:Analyst', 'NOTE:x');
    const result = changed(card, { organization: '', title: '', note: '' });
    expect(result).not.toEqual(
      expect.arrayContaining([expect.stringMatching(removedFields)]),
    );
  });

  it.each([
    [
      { removeEmails: ['nobody@example.org'] },
      'nobody@example.org is not an email address of this contact',
    ],
    [
      { removePhones: ['+1 555'] },
      '+1 555 is not a phone number of this contact',
    ],
    [
      { givenName: '', familyName: '' },
      'the contact would have no name; pass --name, --given-name, --family-name, or --organization',
    ],
  ])('refuses %p', (changes, reason) => {
    expect(changed(appleCard, changes)).toBe(reason);
  });
});
