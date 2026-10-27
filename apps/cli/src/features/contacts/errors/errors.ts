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
