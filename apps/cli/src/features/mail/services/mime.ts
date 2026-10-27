import { Effect } from 'effect';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Account } from '../../../shared/accounts/account';
import { DraftError } from '../errors/errors';
import type { DraftInput, FullMessage } from '../schemas/mail';
import { buildReplyContent } from './reply-quote';
import { textToHtml } from './text-to-html';

export const buildMime = (
  account: Account,
  input: DraftInput,
  repliedTo: FullMessage | undefined,
): Effect.Effect<Buffer, DraftError> =>
  Effect.tryPromise({
    try: () => {
      const html = input.html ?? textToHtml(input.text);
      const content =
        repliedTo === undefined
          ? { text: input.text, html, inReplyTo: undefined, references: [] }
          : buildReplyContent(input.text, html, repliedTo);
      const message = new MailComposer({
        from: { name: account.name, address: account.email },
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: content.text,
        html: content.html,
        attachments: input.attachments?.map((path) => ({ path })),
        textEncoding: 'base64',
        disableUrlAccess: true,
        inReplyTo: content.inReplyTo,
        references: [...content.references],
      }).compile();
      message.keepBcc = true;
      return message.build();
    },
    catch: (cause) =>
      new DraftError({ message: `failed to build draft: ${String(cause)}` }),
  });
