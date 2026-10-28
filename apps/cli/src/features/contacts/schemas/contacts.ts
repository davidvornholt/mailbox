export type AddressBook = {
  readonly account: string;
  readonly href: string;
  readonly name: string;
  readonly description?: string;
  readonly writable?: boolean;
};

export type ContactSummary = {
  readonly account: string;
  readonly addressBook: string;
  readonly href: string;
  readonly name: string;
  readonly organization?: string;
  readonly emails: ReadonlyArray<string>;
  readonly phones: ReadonlyArray<string>;
};

// A value with its vCard TYPE, such as work or home.
export type TypedValue = {
  readonly value: string;
  readonly type?: string;
};

export type PostalAddress = {
  readonly type?: string;
  readonly street?: string;
  readonly locality?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country?: string;
};

export type ContactDetail = {
  readonly account: string;
  readonly href: string;
  readonly etag?: string;
  readonly uid?: string;
  readonly name: string;
  readonly familyName?: string;
  readonly givenName?: string;
  readonly nickname?: string;
  readonly organization?: string;
  readonly title?: string;
  readonly emails: ReadonlyArray<TypedValue>;
  readonly phones: ReadonlyArray<TypedValue>;
  readonly addresses: ReadonlyArray<PostalAddress>;
  readonly birthday?: string;
  readonly urls: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  readonly note?: string;
  readonly vcard?: string;
};
