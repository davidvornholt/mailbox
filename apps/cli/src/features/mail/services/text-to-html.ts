export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const paragraphBreak = /\n{2,}/u;

// The capture group makes split() keep each URL candidate at an odd index.
const urlCandidate = /(?<url>https?:\/\/[^\s<>"“”„‘’«»]+)/iu;
const urlWithHost = /^https?:\/\/[^/?#]/iu;
const trailingPunctuation = new Set(['.', ',', ':', ';', '!', '?', "'"]);
const openingBracketFor: Readonly<Record<string, string>> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

const countOf = (value: string, character: string): number =>
  value.split(character).length - 1;

// Sentence punctuation and unmatched closing brackets after a URL belong to
// the surrounding text, so "(see https://example.com)." links only the URL.
const trimUrlEnd = (candidate: string): string => {
  const last = candidate.at(-1) ?? '';
  const opening = openingBracketFor[last];
  const belongsToText =
    trailingPunctuation.has(last) ||
    (opening !== undefined &&
      countOf(candidate, last) > countOf(candidate, opening));
  return belongsToText ? trimUrlEnd(candidate.slice(0, -1)) : candidate;
};

const linkUrl = (candidate: string): string => {
  const url = trimUrlEnd(candidate);
  if (!urlWithHost.test(url)) {
    return escapeHtml(candidate);
  }
  const escapedUrl = escapeHtml(url);
  return `<a href="${escapedUrl}">${escapedUrl}</a>${escapeHtml(candidate.slice(url.length))}`;
};

const paragraphToHtml = (paragraph: string): string =>
  paragraph
    .split(urlCandidate)
    .map((part, index) => (index % 2 === 1 ? linkUrl(part) : escapeHtml(part)))
    .join('')
    .replaceAll('\n', '<br>');

export const textToHtml = (text: string): string =>
  text
    .trim()
    .split(paragraphBreak)
    .map((paragraph) => `<p>${paragraphToHtml(paragraph)}</p>`)
    .join('\n');
