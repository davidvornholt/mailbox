import { describe, expect, it } from 'bun:test';
import { textToHtml } from './text-to-html';

describe('textToHtml', () => {
  it('escapes HTML-special characters', () => {
    expect(textToHtml('Is 2 < 3 & "yes"?')).toBe(
      '<p>Is 2 &lt; 3 &amp; &quot;yes&quot;?</p>',
    );
  });

  it('wraps blank-line-separated paragraphs and keeps single line breaks', () => {
    expect(textToHtml('First line\nsecond line\n\nNext paragraph\n')).toBe(
      '<p>First line<br>second line</p>\n<p>Next paragraph</p>',
    );
  });

  it('links http and https URLs and escapes them in the link', () => {
    expect(
      textToHtml('Docs: https://example.com/a?b=1&c=2 or HTTP://EXAMPLE.ORG'),
    ).toBe(
      '<p>Docs: <a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a> or <a href="HTTP://EXAMPLE.ORG">HTTP://EXAMPLE.ORG</a></p>',
    );
  });

  it('keeps a link on its own line in a signature', () => {
    expect(textToHtml('David Vornholt\nhttps://david.vornholt.online')).toBe(
      '<p>David Vornholt<br><a href="https://david.vornholt.online">https://david.vornholt.online</a></p>',
    );
  });

  it('leaves trailing punctuation and unmatched closing brackets outside the link', () => {
    expect(
      textToHtml(
        'See https://example.com/path. Or (https://example.com/x), and https://en.wikipedia.org/wiki/Foo_(bar)!',
      ),
    ).toBe(
      '<p>See <a href="https://example.com/path">https://example.com/path</a>. Or (<a href="https://example.com/x">https://example.com/x</a>), and <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>!</p>',
    );
  });

  it('ends a link at angle brackets and quotation marks', () => {
    expect(
      textToHtml('<https://example.com> „https://example.de“ "https://a.b"'),
    ).toBe(
      '<p>&lt;<a href="https://example.com">https://example.com</a>&gt; „<a href="https://example.de">https://example.de</a>“ &quot;<a href="https://a.b">https://a.b</a>&quot;</p>',
    );
  });

  it('does not link a scheme without a host or a domain without a scheme', () => {
    expect(textToHtml('https:// and https://. and david.vornholt.online')).toBe(
      '<p>https:// and https://. and david.vornholt.online</p>',
    );
  });
});
