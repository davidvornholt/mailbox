import { Schema } from 'effect';

export class ContactDataError extends Schema.TaggedError<ContactDataError>()(
  'ContactDataError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}

export class AddressBookNotFoundError extends Schema.TaggedError<AddressBookNotFoundError>()(
  'AddressBookNotFoundError',
  {
    addressBook: Schema.String,
    message: Schema.String,
  },
) {}

export class ReadOnlyAddressBookError extends Schema.TaggedError<ReadOnlyAddressBookError>()(
  'ReadOnlyAddressBookError',
  {
    addressBook: Schema.String,
    message: Schema.String,
  },
) {}

// A contact pim does not change, or a change it does not make.
export class ContactChangeError extends Schema.TaggedError<ContactChangeError>()(
  'ContactChangeError',
  {
    href: Schema.String,
    message: Schema.String,
  },
) {}
