import type { FullMessage, MessageThread } from '../schemas/mail';
import { safeAttributionText } from './attribution-safety';
import { escapeHtml } from './text-to-html';

type ReplyContent = {
  readonly text: string;
  readonly html: string;
  readonly inReplyTo: string | undefined;
  readonly references: ReadonlyArray<string>;
};

const replyDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
});

const replyTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hourCycle: 'h23',
  timeStyle: 'short',
});

const formatReplyDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${replyDateFormatter.format(date)} at ${replyTimeFormatter.format(date)}`;
};

const attributionFor = (message: FullMessage): string => {
  const attributionDate = safeAttributionText(message.attributionDate);
  const from = safeAttributionText(message.from);
  if (attributionDate !== '' && from !== '') {
    return `On ${formatReplyDate(attributionDate)}, ${from} wrote:`;
  }
  if (from !== '') {
    return `${from} wrote:`;
  }
  if (attributionDate !== '') {
    return `On ${formatReplyDate(attributionDate)}, the sender wrote:`;
  }
  return 'Previous message:';
};

const quotePlainText = (text: string): string =>
  text
    .trimEnd()
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');

const quoteHtmlText = (text: string): string =>
  escapeHtml(text.trimEnd()).replaceAll('\n', '<br>');

export const threadReferences = (
  message: MessageThread,
): ReadonlyArray<string> => {
  const ancestry =
    message.references.length > 0
      ? message.references
      : [message.inReplyTo].filter((reference) => reference !== '');
  return [...new Set([...ancestry, message.messageId])].filter(
    (reference) => reference !== '',
  );
};

export const buildReplyContent = (
  text: string,
  html: string,
  message: FullMessage,
): ReplyContent => {
  const attribution = attributionFor(message);
  return {
    text: `${text.trimEnd()}\n\n${attribution}\n${quotePlainText(message.text)}`,
    html: `${html.trimEnd()}\n<p>${escapeHtml(attribution)}</p>\n<blockquote type="cite">${quoteHtmlText(message.text)}</blockquote>`,
    inReplyTo: message.messageId === '' ? undefined : message.messageId,
    references: threadReferences(message),
  };
};
