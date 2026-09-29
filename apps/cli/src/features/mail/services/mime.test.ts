import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { simpleParser } from 'mailparser';
import type { Account } from '../schemas/account';
import type { DraftInput, FullMessage } from '../schemas/mail';
import { buildMime } from './mime';

const account: Account = {
  email: 'sender@example.com',
  name: 'Example Sender',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'sender@example.com',
  auth: 'password',
};

const draft = (input: Partial<DraftInput>): DraftInput => ({
  account: account.email,
  to: 'recipient@example.com',
  subject: 'Subject',
  text: 'Body',
  ...input,
});

const buildAndParse = async (
  input: DraftInput,
  repliedTo?: FullMessage,
): Promise<{
  raw: Buffer;
  parsed: Awaited<ReturnType<typeof simpleParser>>;
}> => {
  const raw = await Effect.runPromise(buildMime(account, input, repliedTo));
  return { raw, parsed: await simpleParser(raw) };
};

describe('buildMime', () => {
  it('preserves authored plain-text line breaks without quoted-printable wrapping', async () => {
    const repetitionsPastTransferLineLength = 12;
    const text = 'A deliberately long paragraph '
      .repeat(repetitionsPastTransferLineLength)
      .trim();
    const { raw, parsed } = await buildAndParse(draft({ text }));

    expect(raw.toString()).toContain('Content-Transfer-Encoding: base64');
    expect(parsed.text?.trimEnd()).toBe(text);
  });

  it('derives an escaped HTML alternative when html is omitted', async () => {
    const { parsed } = await buildAndParse(
      draft({ text: 'First line\nsecond line\n\nIs 2 < 3 & sure?' }),
    );

    expect(parsed.html).toContain('<p>First line<br>second line</p>');
    expect(parsed.html).toContain('<p>Is 2 &lt; 3 &amp; sure?</p>');
  });

  it('keeps Bcc recipients in stored draft MIME', async () => {
    const bcc = 'hidden@example.com';
    const { raw, parsed } = await buildAndParse(draft({ bcc }));
    const parsedBcc = Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc;

    expect(raw.toString()).toContain(`Bcc: ${bcc}\r\n`);
    expect(parsedBcc?.text).toBe(bcc);
  });

  it('builds HTML alternatives and file attachments', async () => {
    const attachmentPath = Bun.fileURLToPath(
      new URL('attachment.fixture.txt', import.meta.url),
    );
    const { parsed } = await buildAndParse(
      draft({
        text: 'Plain fallback',
        html: '<p><strong>Rich</strong> message</p>',
        attachments: [attachmentPath],
      }),
    );

    expect(parsed.text?.trim()).toBe('Plain fallback');
    expect(parsed.html).toContain('<strong>Rich</strong>');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('attachment.fixture.txt');
    expect(parsed.attachments[0]?.content.toString().trim()).toBe(
      'attachment contents',
    );
  });

  it('quotes the replied-to message and derives its threading headers', async () => {
    const { parsed } = await buildAndParse(
      draft({
        subject: 'Re: Question',
        text: 'My answer.',
      }),
      {
        uid: 42,
        folder: 'INBOX',
        from: 'Original Sender <original@example.com>',
        to: account.email,
        cc: '',
        bcc: '',
        subject: 'Question',
        date: '2026-07-13T08:30:00.000Z',
        attributionDate: '2026-07-13T08:30:00',
        messageId: '<current@example.com>',
        inReplyTo: '<first@example.com>',
        references: ['<first@example.com>'],
        text: 'First line\n\nSecond line',
        html: '<p>First line</p><img src="https://example.com/pixel">',
        attachments: [],
      },
    );

    expect(parsed.text?.trimEnd()).toBe(
      'My answer.\n\nOn July 13, 2026 at 08:30, Original Sender <original@example.com> wrote:\n> First line\n>\n> Second line',
    );
    expect(parsed.html).toBe(
      '<p>My answer.</p>\n<p>On July 13, 2026 at 08:30, Original Sender &lt;original@example.com&gt; wrote:</p>\n<blockquote type="cite">First line<br><br>Second line</blockquote>',
    );
    expect(parsed.inReplyTo).toBe('<current@example.com>');
    expect(parsed.references).toEqual([
      '<first@example.com>',
      '<current@example.com>',
    ]);
  });
});
