import { DateTime, Effect } from 'effect';
import {
  type Partstat,
  partstats,
  readInvitation,
} from '../features/calendar/services/invitation';
import { describeInvitation } from '../features/calendar/services/invitation-copies';
import { answerInvitation } from '../features/calendar/services/invitation-reply';
import { Imap } from '../features/mail/services/imap';
import { AccountConfig } from '../shared/accounts/config';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import { type CommandEffect, json } from './command-support';

const messageFlags = {
  account: flag.text('email', 'Account the invitation arrived in'),
  folder: flag.text('path', 'Folder from a search hit'),
  uid: flag.integer('n', 'Message uid from a search hit'),
} as const;

const receivedInvitation = (values: {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
}) =>
  Effect.gen(function* () {
    const config = yield* AccountConfig;
    const account = yield* config.getAccount(values.account);
    const imap = yield* Imap;
    const message = yield* imap.readCalendar(
      account.email,
      values.folder,
      values.uid,
    );
    const invitation = yield* readInvitation(
      `Message uid ${message.uid} in "${message.folder}"`,
      message.ics,
      message.method,
    );
    return { account, message, invitation };
  });

const show = defineCommand(
  {
    name: 'calendar invitation',
    summary: 'Show the meeting an invitation email describes',
    description:
      'Read the calendar data (text/calendar) of an email, such as an invitation, and show its iTIP method (request invites, cancel cancels, reply answers), its sequence, which grows with each update, and the meeting. "attendee" is the address the user is invited as. For an account with [accounts.dav], "copies" lists the meeting in the user\'s calendars with their answer there.',
    flags: messageFlags,
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const { account, invitation } = yield* receivedInvitation(values);
      return json(
        yield* describeInvitation(
          account,
          invitation,
          DateTime.zoneMakeLocal(),
        ),
      );
    }),
);

const isPartstat = (value: string): value is Partstat =>
  (partstats as ReadonlyArray<string>).includes(value);

const respond = defineCommand(
  {
    name: 'calendar respond',
    summary: 'Answer an invitation email',
    description:
      'Answer an invitation (method request) as the attendee. For an account with [accounts.dav] whose server sends answers itself (RFC 6638), pim adds the meeting to a calendar, unanswered, and then gives the answer there, which makes the server email the organizer; pim does this only with --notify-organizer. It prints {"reply": "server", "event"}, where event.organizer.scheduleStatus tells, when the server reports it, how it delivered the answer (1.x: sent or pending). For any other account, pim saves the answer as a reply draft to the organizer, with the calendar data their calendar reads, and prints {"reply": "draft", "draft", "to", "subject"}. The user sends the draft from their mail app; pim writes no calendar then.',
    flags: {
      ...messageFlags,
      partstat: flag.text(partstats.join('|'), 'The answer'),
      calendar: flag.optionalText(
        'name|href',
        'Calendar from "pim calendar list" for a meeting in none of them yet; needed when the account has several',
      ),
      notifyOrganizer: flag.switch(
        'Allow the answer that makes the calendar server email the organizer. Pass it only when the user asked to answer',
      ),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const { partstat } = values;
      if (!isPartstat(partstat)) {
        return yield* new UsageError({
          message: `pim calendar respond: --partstat must be ${partstats.join(', ')}, not "${partstat}"`,
        });
      }
      const { account, message, invitation } =
        yield* receivedInvitation(values);
      const outcome = yield* answerInvitation(
        account,
        invitation,
        {
          partstat,
          ...(values.calendar === undefined
            ? {}
            : { calendar: values.calendar }),
          notifyOrganizer: values.notifyOrganizer,
        },
        DateTime.zoneMakeLocal(),
      );
      if (outcome._tag === 'Answered') {
        return json({ reply: 'server', event: outcome.event });
      }
      const { reply } = outcome;
      const imap = yield* Imap;
      const draft = yield* imap.saveCalendarReply({
        account: account.email,
        ...reply,
        repliedTo: message,
      });
      return json({
        reply: 'draft',
        draft,
        to: reply.to,
        subject: reply.subject,
      });
    }),
);

export const invitationCommands = [show, respond];
