import { describe, expect, it } from 'bun:test';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer';
import { calendarPart } from './calendar-part';

const ics = (method: string) =>
  `BEGIN:VCALENDAR\r\nMETHOD:${method}\r\nEND:VCALENDAR\r\n`;

const partOf = async (message: Mail.Options) => {
  const raw = await new MailComposer({
    from: 'boss@example.com',
    to: 'me@example.com',
    subject: 'Review',
    text: 'Agenda',
    ...message,
  })
    .compile()
    .build();
  return calendarPart((await simpleParser(raw)).attachments);
};

describe('calendarPart', () => {
  it('takes the text/calendar part with the method over a calendar file before it', async () => {
    const part = await partOf({
      attachments: [
        { filename: 'old.ics', content: ics('PUBLISH') },
        {
          contentType: 'text/calendar; method=REQUEST',
          content: ics('REQUEST'),
        },
      ],
    });
    expect(part?.content.toString()).toBe(ics('REQUEST'));
  });

  it('falls back to a calendar file of any type', async () => {
    const part = await partOf({
      attachments: [
        {
          filename: 'meeting.ICS',
          contentType: 'application/octet-stream',
          content: ics('REQUEST'),
        },
      ],
    });
    expect(part?.filename).toBe('meeting.ICS');
  });

  it('finds none in a message without calendar data', async () => {
    expect(
      await partOf({
        attachments: [{ filename: 'notes.txt', content: 'notes' }],
      }),
    ).toBeUndefined();
  });
});
