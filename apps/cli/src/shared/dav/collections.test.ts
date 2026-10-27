import { describe, expect, it } from 'bun:test';
import { Result } from 'effect';
import { collectionPath, findCollection, lastSegment } from './collections';

const collections = [
  { href: '/calendars/me/work%20items/', name: 'Work' },
  { href: '/calendars/me/home/', name: 'Home' },
  { href: '/calendars/me/shared-home/', name: 'home' },
];

describe('collectionPath', () => {
  it.each([
    ['/calendars/me/work%20items', '/calendars/me/work items/'],
    ['https://dav.example.com/calendars/me/home//', '/calendars/me/home/'],
    ['/calendars/me/home/', '/calendars/me/home/'],
  ])('normalizes %s', (href, path) => {
    expect(collectionPath(href)).toBe(path);
  });
});

describe('lastSegment', () => {
  it('names a collection after the end of its decoded href', () => {
    expect(lastSegment('/calendars/me/work%20items/')).toBe('work items');
  });
});

describe('findCollection', () => {
  it('finds a collection by its href in any spelling', () => {
    const found = findCollection(collections, '/calendars/me/work items');
    expect(Result.getOrUndefined(found)?.name).toBe('Work');
  });

  it('finds a collection by its name, ignoring case', () => {
    const found = findCollection(collections, ' work ');
    expect(Result.getOrUndefined(found)?.href).toBe(
      '/calendars/me/work%20items/',
    );
  });

  it('refuses a name that several collections share', () => {
    expect(findCollection(collections, 'HOME')).toEqual(
      Result.fail('ambiguous'),
    );
  });

  it('reports a collection that does not exist', () => {
    expect(findCollection(collections, 'Holidays')).toEqual(
      Result.fail('missing'),
    );
  });
});
