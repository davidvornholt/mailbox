import { Effect } from 'effect';
import { type DavClient, xmlBody } from '../../../shared/dav/client';
import { lastSegment } from '../../../shared/dav/collections';
import {
  discoverPrincipal,
  listCollections,
} from '../../../shared/dav/discovery';
import {
  type DavResource,
  hasResourceType,
  ns,
  propText,
} from '../../../shared/dav/xml';
import { DavError, type DavRequestError } from '../../../shared/errors/dav';
import type { AddressBook } from '../schemas/contacts';

// The vCard text of one contact, with the ETag a later change must match.
export type ContactResource = {
  readonly href: string;
  readonly etag: string | undefined;
  readonly vcard: string;
};

export const listAddressBooks = (
  client: DavClient,
): Effect.Effect<ReadonlyArray<AddressBook>, DavRequestError> =>
  Effect.gen(function* () {
    const principal = yield* discoverPrincipal(client);
    if (principal.addressBookHome === undefined) {
      return yield* new DavError({
        message: `The DAV server of ${client.login.account} offers no contacts (it names no addressbook-home-set)`,
      });
    }
    const collections = yield* listCollections(
      client,
      principal.addressBookHome,
      '<d:resourcetype/><d:displayname/><card:addressbook-description/>',
    );
    return collections
      .filter((resource) =>
        hasResourceType(resource, ns.carddav, 'addressbook'),
      )
      .map((resource) => {
        const description = propText(
          resource,
          ns.carddav,
          'addressbook-description',
        );
        return {
          account: client.login.account,
          href: resource.href,
          name:
            propText(resource, ns.dav, 'displayname') ??
            lastSegment(resource.href),
          ...(description === undefined ? {} : { description }),
        };
      });
  });

const toContactResource = (
  resource: DavResource,
): ReadonlyArray<ContactResource> => {
  const vcard = propText(resource, ns.carddav, 'address-data');
  return vcard === undefined
    ? []
    : [
        {
          href: resource.href,
          etag: propText(resource, ns.dav, 'getetag'),
          vcard,
        },
      ];
};

// Every contact in the address book. An empty filter matches all of them
// (RFC 6352, section 10.5); searching happens locally, because servers
// differ in which text matches they support.
export const queryContacts = (
  client: DavClient,
  addressBookHref: string,
): Effect.Effect<ReadonlyArray<ContactResource>, DavRequestError> =>
  client
    .report(
      addressBookHref,
      '1',
      xmlBody(
        'card:addressbook-query',
        '<d:prop><d:getetag/><card:address-data/></d:prop><card:filter/>',
      ),
    )
    .pipe(Effect.map((resources) => resources.flatMap(toContactResource)));

export const fetchContact = (
  client: DavClient,
  href: string,
): Effect.Effect<ContactResource, DavRequestError> =>
  client.send({ method: 'GET', href }).pipe(
    Effect.map((reply) => ({
      href,
      etag: reply.headers.get('etag') ?? undefined,
      vcard: reply.body,
    })),
  );
