import { Effect } from 'effect';
import type { DavRequestError } from '../errors/dav';
import type { DavClient } from './client';

// A calendar object or contact as pim stores it.
export type ResourceBody = {
  readonly href: string;
  readonly body: string;
  readonly contentType: string;
};

// Some servers, Infomaniak among them, answer a PUT with an unquoted ETag
// but quote it on GET, as HTTP requires (RFC 9110, section 8.8.3). Quoting
// it lets the etag pim prints match the one a later read returns.
const entityTag = (etag: string): string =>
  etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;

const put = (
  client: DavClient,
  resource: ResourceBody,
  precondition: Readonly<Record<string, string>>,
): Effect.Effect<string | undefined, DavRequestError> =>
  client.send({ method: 'PUT', ...resource, headers: precondition }).pipe(
    Effect.map((reply) => {
      const etag = reply.headers.get('etag');
      return etag === null ? undefined : entityTag(etag);
    }),
  );

// Stores a new resource, and never replaces one at the same href. Returns its
// ETag, which the server leaves out when it changed the data as it stored it
// (RFC 4791, section 5.3.4).
export const createResource = (
  client: DavClient,
  resource: ResourceBody,
): Effect.Effect<string | undefined, DavRequestError> =>
  put(client, resource, { 'if-none-match': '*' });

// Replaces the resource only while the server still holds the version with
// this ETag.
export const replaceResource = (
  client: DavClient,
  resource: ResourceBody,
  etag: string,
): Effect.Effect<string | undefined, DavRequestError> =>
  put(client, resource, { 'if-match': etag });

// Deletes the resource only while the server still holds the version with
// this ETag.
export const deleteResource = (
  client: DavClient,
  href: string,
  etag: string,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<void, DavRequestError> =>
  client
    .send({ method: 'DELETE', href, headers: { ...headers, 'if-match': etag } })
    .pipe(Effect.asVoid);
