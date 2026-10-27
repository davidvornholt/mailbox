import { Result } from 'effect';

// A calendar or address book, as the commands name it.
export type NamedCollection = {
  readonly href: string;
  readonly name: string;
};

const trailingSlashes = /\/*$/u;

// Decodes percent escapes. Text with an invalid escape, such as the calendar
// name "100% focus" or a malformed href from a server, stays as written.
export const decodePercent = (text: string): string =>
  Result.getOrElse(
    Result.try(() => decodeURIComponent(text)),
    () => text,
  );

// The decoded path of an href, with one trailing slash, so that hrefs from
// the command line and from the server compare equal.
export const collectionPath = (href: string): string =>
  decodePercent(
    URL.parse(href, 'https://dav.invalid')?.pathname ?? href,
  ).replace(trailingSlashes, '/');

// The path of an href as the server escaped it, with one trailing slash.
// Escapes stay, so /a%2Fb/ and /a/b/ remain two collections.
export const serverPath = (href: string): string =>
  (URL.parse(href, 'https://dav.invalid')?.pathname ?? href).replace(
    trailingSlashes,
    '/',
  );

export const lastSegment = (href: string): string =>
  decodePercent(href.replace(trailingSlashes, '').split('/').at(-1) ?? href);

// Finds a collection by its href or, case-insensitively, by its name.
export const findCollection = <C extends NamedCollection>(
  collections: ReadonlyArray<C>,
  wanted: string,
): Result.Result<C, 'ambiguous' | 'missing'> => {
  const byHref = collections.find(
    (collection) => collectionPath(collection.href) === collectionPath(wanted),
  );
  if (byHref !== undefined) {
    return Result.succeed(byHref);
  }
  const name = wanted.trim().toLowerCase();
  const byName = collections.filter(
    (collection) => collection.name.toLowerCase() === name,
  );
  const [found] = byName;
  if (found === undefined) {
    return Result.fail('missing');
  }
  return byName.length === 1 ? Result.succeed(found) : Result.fail('ambiguous');
};

export const describeCollections = (
  collections: ReadonlyArray<NamedCollection>,
): string =>
  collections
    .map((collection) => `${collection.name} (${collection.href})`)
    .join(', ');
