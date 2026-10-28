import { Effect } from 'effect';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Account } from '../../../shared/accounts/account';
import { DraftError } from '../errors/errors';
import type {
  CalendarReplyDraft,
  DraftInput,
  FullMessage,
} from '../schemas/mail';
import { buildReplyContent, threadReferences } from './reply-quote';
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

// nodemailer puts the reply in a text/calendar part with its method, which
// calendar apps read, and in a reply.ics file for the others.
export const buildCalendarReply = (
  account: Account,
  draft: CalendarReplyDraft,
): Effect.Effect<Buffer, DraftError> =>
  Effect.tryPromise({
    try: () => {
      const { messageId } = draft.repliedTo;
      return new MailComposer({
        from: { name: account.name, address: account.email },
        to: draft.to,
        subject: draft.subject,
        text: draft.text,
        icalEvent: {
          method: 'REPLY',
          filename: 'reply.ics',
          content: draft.ics,
        },
        textEncoding: 'base64',
        disableUrlAccess: true,
        inReplyTo: messageId === '' ? undefined : messageId,
        references: [...threadReferences(draft.repliedTo)],
      })
        .compile()
        .build();
    },
    catch: (cause) =>
      new DraftError({
        message: `failed to build the reply draft: ${String(cause)}`,
      }),
  });
