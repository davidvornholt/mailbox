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

export const onlyOne = <C>(
  matches: ReadonlyArray<C>,
): Result.Result<C, 'ambiguous' | 'missing'> => {
  const [found] = matches;
  if (found === undefined) {
    return Result.fail('missing');
  }
  return matches.length === 1
    ? Result.succeed(found)
    : Result.fail('ambiguous');
};

export const findCollection = <C extends NamedCollection>(
  collections: ReadonlyArray<C>,
  wanted: string,
): Result.Result<C, 'ambiguous' | 'missing'> => {
  const exact = collections.find(
    (collection) => serverPath(collection.href) === serverPath(wanted),
  );
  if (exact !== undefined) {
    return Result.succeed(exact);
  }
  const byHref = collections.filter(
    (collection) => collectionPath(collection.href) === collectionPath(wanted),
  );
  if (byHref.length > 0) {
    return onlyOne(byHref);
  }
  const name = wanted.trim().toLowerCase();
  return onlyOne(
    collections.filter((collection) => collection.name.toLowerCase() === name),
  );
};

export const describeCollections = (
  collections: ReadonlyArray<NamedCollection>,
): string =>
  collections
    .map((collection) => `${collection.name} (${collection.href})`)
    .join(', ');
