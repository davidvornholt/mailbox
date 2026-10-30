import type { MessageStructureObject } from 'imapflow';
import type { MessageAttachment } from '../schemas/mail';

const parameter = (
  parameters: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined =>
  Object.entries(parameters ?? {}).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];

const toAttachment = (
  node: MessageStructureObject,
): MessageAttachment | undefined => {
  const { part } = node;
  const disposition = node.disposition?.toLowerCase() ?? null;
  const filename =
    parameter(node.dispositionParameters, 'filename') ??
    parameter(node.parameters, 'name') ??
    null;
  const isMessageBody = ['text/plain', 'text/html', 'text/x-amp-html'].includes(
    node.type.toLowerCase(),
  );
  // An invitation's text/calendar part sits beside the message text, often
  // without a file name (RFC 6047, section 2.4).
  const isAttachment =
    disposition === 'attachment' ||
    filename !== null ||
    node.type.toLowerCase() === 'text/calendar' ||
    (node.id !== undefined && !isMessageBody);
  if (part === undefined || !isAttachment) {
    return;
  }
  return {
    part,
    filename,
    contentType: node.type,
    size: node.size ?? null,
    disposition,
    contentId: node.id ?? null,
  };
};

// imapflow numbers the parts of a multipart message but leaves the body of
// any other message without a number. IMAP numbers that body part 1 (RFC
// 3501, section 6.4.5), so a message that is a single file, such as a scan
// or an invitation, has its attachment there.
const numbered = (structure: MessageStructureObject): MessageStructureObject =>
  structure.part === undefined && structure.childNodes === undefined
    ? { ...structure, part: '1' }
    : structure;

export const listAttachments = (
  structure: MessageStructureObject | undefined,
): ReadonlyArray<MessageAttachment> => {
  if (structure === undefined) {
    return [];
  }
  const attachments: Array<MessageAttachment> = [];
  const pending = [numbered(structure)];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node !== undefined) {
      const attachment = toAttachment(node);
      if (attachment === undefined) {
        pending.push(...[...(node.childNodes ?? [])].reverse());
      } else {
        attachments.push(attachment);
      }
    }
  }
  return attachments;
};

export const findAttachment = (
  structure: MessageStructureObject | undefined,
  part: string,
): MessageAttachment | undefined => {
  const pending = structure === undefined ? [] : [numbered(structure)];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.part === part) {
      return toAttachment(node);
    }
    if (node !== undefined) {
      pending.push(...(node.childNodes ?? []));
    }
  }
};
