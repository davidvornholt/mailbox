// RFC 7162 section 4 asks clients to keep each command line near 8192 octets.
// This leaves room for the tag, the UID FETCH verb, and the fetch items.
const maxUidSetLength = 8000;

type UidRun = { first: number; last: number };

const uidRuns = (uids: ReadonlyArray<number>): ReadonlyArray<UidRun> => {
  const runs: Array<UidRun> = [];
  for (const uid of [...new Set(uids)].sort((left, right) => left - right)) {
    const current = runs.at(-1);
    if (current !== undefined && current.last + 1 === uid) {
      current.last = uid;
    } else {
      runs.push({ first: uid, last: uid });
    }
  }
  return runs;
};

const formatRun = ({ first, last }: UidRun): string =>
  first === last ? `${first}` : `${first}:${last}`;

// Pack UIDs into IMAP sequence sets such as `1:5,9,12:14`, split so each set
// fits on one command line. Consecutive UIDs collapse into one range, so a
// folder whose matches are mostly contiguous needs a single FETCH.
export const uidSets = (uids: ReadonlyArray<number>): ReadonlyArray<string> => {
  const sets: Array<string> = [];
  let current = '';
  for (const range of uidRuns(uids).map(formatRun)) {
    if (current === '') {
      current = range;
    } else if (current.length + 1 + range.length <= maxUidSetLength) {
      current = `${current},${range}`;
    } else {
      sets.push(current);
      current = range;
    }
  }
  return current === '' ? sets : [...sets, current];
};
