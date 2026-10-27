import { Array as Arr, Effect } from 'effect';
import { DavError, type DavRequestError } from '../errors/dav';
import type { DavClient } from './client';
import { collectionPath } from './collections';
import { type DavResource, ns, propHrefs, propText } from './xml';

export type Principal = {
  readonly href: string;
  readonly displayName: string | undefined;
  // A user may have several homes (RFC 4791, section 6.2.1).
  readonly calendarHomes: ReadonlyArray<string>;
  readonly addressBookHomes: ReadonlyArray<string>;
  // Addresses the server treats as this user in invitations, such as
  // mailto:me@example.com, as bare emails.
  readonly addresses: ReadonlyArray<string>;
};

// Proves the login works: the server names the signed-in user's principal.
export const currentUserPrincipal = (
  client: DavClient,
): Effect.Effect<string, DavRequestError> =>
  client.propfind(client.login.url, '0', '<d:current-user-principal/>').pipe(
    Effect.flatMap((resources) => {
      const [href] = resources.flatMap((resource) =>
        propHrefs(resource, ns.dav, 'current-user-principal'),
      );
      return href === undefined
        ? Effect.fail(
            new DavError({
              message: `${client.login.url} did not name the signed-in user; set dav.url to the server's DAV root`,
            }),
          )
        : Effect.succeed(href);
    }),
  );

const mailtoPrefix = 'mailto:';

export const discoverPrincipal = (
  client: DavClient,
): Effect.Effect<Principal, DavRequestError> =>
  Effect.gen(function* () {
    const href = yield* currentUserPrincipal(client);
    const [principal] = yield* client.propfind(
      href,
      '0',
      '<d:displayname/><c:calendar-home-set/><card:addressbook-home-set/><c:calendar-user-address-set/>',
    );
    return {
      href,
      displayName:
        principal === undefined
          ? undefined
          : propText(principal, ns.dav, 'displayname'),
      calendarHomes:
        principal === undefined
          ? []
          : propHrefs(principal, ns.caldav, 'calendar-home-set'),
      addressBookHomes:
        principal === undefined
          ? []
          : propHrefs(principal, ns.carddav, 'addressbook-home-set'),
      addresses:
        principal === undefined
          ? []
          : propHrefs(principal, ns.caldav, 'calendar-user-address-set')
              .filter((address) =>
                address.toLowerCase().startsWith(mailtoPrefix),
              )
              .map((address) =>
                decodeURIComponent(address.slice(mailtoPrefix.length)),
              ),
    };
  });

// The homes and the collections directly inside them, each once. A home can
// itself be a calendar or an address book, so callers filter by resource type.
export const listCollections = (
  client: DavClient,
  homes: ReadonlyArray<string>,
  props: string,
): Effect.Effect<ReadonlyArray<DavResource>, DavRequestError> =>
  Effect.forEach(homes, (home) => client.propfind(home, '1', props)).pipe(
    Effect.map((listings) =>
      Arr.dedupeWith(
        listings.flat(),
        (left, right) =>
          collectionPath(left.href) === collectionPath(right.href),
      ),
    ),
  );
