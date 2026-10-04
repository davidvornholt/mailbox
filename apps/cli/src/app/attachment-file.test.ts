import { afterAll, describe, expect, it } from 'bun:test';
import { Effect, Result } from 'effect';
import type { AttachmentContent } from '../features/mail/schemas/mail';
import { checkOut, safeFilename, writeAttachment } from './attachment-file';

const tempDir = `${Bun.env.TMPDIR ?? '/tmp'}/mailbox-attachment-test-${crypto.randomUUID()}`;

const attachment = (filename: string | null): AttachmentContent => ({
  part: '2',
  filename,
  contentType: 'text/plain',
  size: null,
  disposition: 'attachment',
  contentId: null,
  content: new TextEncoder().encode('content'),
});

const write = (file: AttachmentContent, out: string, force = false) =>
  Effect.runPromise(Effect.result(writeAttachment(file, out, force)));

afterAll(async () => {
  await Bun.$`rm -rf ${tempDir}`;
});

describe('safeFilename', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\invoice.pdf', 'invoice.pdf'],
    ['.bashrc', 'bashrc'],
    [' .envrc', 'envrc'],
    ['line\nbreak.txt', 'linebreak.txt'],
    ['..', 'attachment-2'],
    [null, 'attachment-2'],
  ])('turns %p into %p', (filename, expected) => {
    expect(safeFilename(filename, '2')).toBe(expected);
  });
});

describe('writeAttachment', () => {
  it('writes into an existing directory under a safe filename', async () => {
    await Bun.$`mkdir -p ${tempDir}/into`;
    const result = await write(attachment('../notes.txt'), `${tempDir}/into/`);
    expect(result).toEqual(Result.succeed(`${tempDir}/into/notes.txt`));
    expect(await Bun.file(`${tempDir}/into/notes.txt`).text()).toBe('content');
  });

  it('keeps an existing file unless forced', async () => {
    const path = `${tempDir}/existing.txt`;
    await Bun.write(path, 'original');
    const refused = await write(attachment('a.txt'), path);
    expect(refused).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'UsageError',
        message: expect.stringContaining('--force'),
      },
    });
    expect(await Bun.file(path).text()).toBe('original');
    const forced = await write(attachment('a.txt'), path, true);
    expect(forced).toEqual(Result.succeed(path));
    expect(await Bun.file(path).text()).toBe('content');
  });

  it('refuses an existing file before downloading', async () => {
    const path = `${tempDir}/checked.txt`;
    await Bun.write(path, 'original');
    const check = (out: string, force: boolean) =>
      Effect.runPromise(Effect.result(checkOut(out, force)));
    expect(await check(path, false)).toMatchObject({ _tag: 'Failure' });
    expect(await check(path, true)).toEqual(Result.succeed(undefined));
    expect(await check(tempDir, false)).toEqual(Result.succeed(undefined));
  });

  it('refuses to replace a directory named like the attachment', async () => {
    await Bun.$`mkdir -p ${tempDir}/nested/b.txt`;
    const result = await write(attachment('b.txt'), `${tempDir}/nested`, true);
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'UsageError' },
    });
  });
});
