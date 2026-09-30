import { describe, expect, it } from 'bun:test';
import { uidSets } from './imap-uid-sets';

const commandLineBudget = 8000;
const scatteredUidCount = 3000;
const firstScatteredUid = 1_000_000;
const runLength = 5;
const isolatedUid = 9;
const trailingUid = 12;

describe('uidSets', () => {
  it('returns no sets for no UIDs', () => {
    expect(uidSets([])).toEqual([]);
  });

  it('sorts, deduplicates, and collapses consecutive UIDs into ranges', () => {
    const run = Array.from({ length: runLength }, (_, index) => index + 1);
    expect(uidSets([trailingUid, ...run.toReversed(), isolatedUid, 2])).toEqual(
      ['1:5,9,12'],
    );
  });

  it('splits scattered UIDs into sets that each fit on one command line', () => {
    const uids = Array.from(
      { length: scatteredUidCount },
      (_, index) => firstScatteredUid + index * 2,
    );

    const sets = uidSets(uids);

    expect(sets.length).toBeGreaterThan(1);
    expect(Math.max(...sets.map((set) => set.length))).toBeLessThanOrEqual(
      commandLineBudget,
    );
    expect(sets.join(',').split(',').map(Number)).toEqual(uids);
  });
});
