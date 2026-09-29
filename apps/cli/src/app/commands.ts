import { Effect } from 'effect';
import { defaultSearchLimit } from '../features/mail/schemas/mail';
import { MailConfig } from '../features/mail/services/config';
import { Imap } from '../features/mail/services/imap';
import { checkAccounts } from '../features/mail/services/status';
import { defineCommand, flag, UsageError } from '../shared/command-line';
import type { Program } from '../shared/command-program';
import { stdinIsTerminal } from '../shared/terminal';
import { checkOut, writeAttachment } from './attachment-file';
import { loginAccounts } from './cli-login';
import {
  type CommandEffect,
  configuredEmail,
  json,
  printed,
} from './command-support';
import { draftCommands } from './draft-commands';

const account = flag.text('email', 'Account email from "mailbox accounts"');
const optionalAccount = (description: string) =>
  flag.optionalText('email', description);
const messageFlags = {
  account,
  folder: flag.text('path', 'Folder from a search hit'),
  uid: flag.integer('n', 'Message uid from a search hit'),
} as const;

const selectedAccounts = (only: string | undefined) =>
  MailConfig.pipe(
    Effect.flatMap((config) =>
      only === undefined
        ? Effect.succeed(config.accounts)
        : config.getAccount(only).pipe(Effect.map((found) => [found])),
    ),
  );

const accounts = defineCommand(
  { name: 'accounts', summary: 'List configured accounts', flags: {} },
  (): CommandEffect =>
    MailConfig.pipe(
      Effect.map((config) =>
        json(
          config.accounts.map(({ email, name, host }) => ({
            email,
            name,
            host,
          })),
        ),
      ),
    ),
);

const status = defineCommand(
  {
    name: 'status',
    summary: 'Check that each account can log in',
    description:
      'Check that each account has credentials in the OS keyring and that it logs in. Exits 1 when any account is not ready; its message says what to do.',
    flags: {
      account: optionalAccount('Check only this account'),
      offline: flag.switch('Only check the keyring; do not connect'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const selected = yield* selectedAccounts(values.account);
      const results = yield* checkAccounts(
        selected.map(({ email }) => email),
        { verify: !values.offline },
      );
      return json(
        results,
        results.some((result) => !result.ok),
      );
    }),
);

const login = defineCommand(
  {
    name: 'login',
    summary: 'Log in and store credentials in the OS keyring',
    description:
      'Prompt for each IMAP password (or app password), or sign in with Microsoft for accounts with auth = "microsoft". Check the login against the server and store it in the OS keyring. Needs an interactive terminal: agents should ask the user to run it.',
    flags: { account: optionalAccount('Log in to only this account') },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      if (!stdinIsTerminal()) {
        return yield* new UsageError({
          message:
            'mailbox login needs an interactive terminal; ask the user to run it',
        });
      }
      const selected = yield* selectedAccounts(values.account);
      const succeeded = yield* loginAccounts(selected);
      return printed(!succeeded);
    }),
);

const folders = defineCommand(
  {
    name: 'folders',
    summary: 'List the folders of an account',
    flags: { account },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      const imap = yield* Imap;
      return json(yield* imap.listFolders(email));
    }),
);

const search = defineCommand(
  {
    name: 'search',
    summary: 'Search messages, newest first',
    description:
      'Search messages, newest first, across all accounts unless --account is given. Without --folder, each account searches its all-mail folder, or else every folder except Drafts, Junk, and Trash. Each hit has an account, folder, uid, and uidValidity. Accounts that fail are listed under "failures" beside the other hits.',
    flags: {
      account: optionalAccount('Search only this account'),
      query: flag.optionalText('text', 'Match subject, body, and addresses'),
      from: flag.optionalText('text', 'Match the sender'),
      subject: flag.optionalText('text', 'Match the subject'),
      since: flag.optionalText('YYYY-MM-DD', 'Only messages from this date on'),
      folder: flag.optionalText('path', 'Search only this folder'),
      subtree: flag.switch('With --folder, include its subfolders'),
      limit: flag.optionalInteger(
        'n',
        `Maximum hits across all accounts (default ${defaultSearchLimit})`,
      ),
    },
  },
  ({ account: only, folder, subtree, limit, ...criteria }): CommandEffect =>
    Effect.gen(function* () {
      if (subtree && folder === undefined) {
        return yield* new UsageError({
          message: 'mailbox search: --subtree needs --folder',
        });
      }
      const email =
        only === undefined ? undefined : yield* configuredEmail(only);
      const imap = yield* Imap;
      const result = yield* imap.search(email, {
        ...criteria,
        limit: limit ?? defaultSearchLimit,
        ...(folder === undefined
          ? {}
          : { folder, scope: subtree ? 'subtree' : 'folder' }),
      });
      return json(result);
    }),
);

const read = defineCommand(
  {
    name: 'read',
    summary: 'Read a message',
    description:
      'Print one message: headers, plain-text body, and attachments. Reading does not mark the message as read. Attachment sizes count encoded bytes, so they overstate the saved file. Save an attachment with "mailbox attachment" and its part.',
    flags: {
      ...messageFlags,
      html: flag.switch('Include the HTML body'),
    },
  },
  ({ html: includeHtml, ...handle }): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(handle.account);
      const imap = yield* Imap;
      const { html, ...message } = yield* imap.read(
        email,
        handle.folder,
        handle.uid,
      );
      return json({
        account: email,
        ...message,
        ...(includeHtml ? { html } : {}),
      });
    }),
);

const attachment = defineCommand(
  {
    name: 'attachment',
    summary: 'Save an attachment to a file',
    flags: {
      ...messageFlags,
      part: flag.text('part', 'Attachment part from "mailbox read"'),
      out: flag.text(
        'path',
        'File to write, or an existing directory to write into',
      ),
      force: flag.switch('Overwrite an existing file'),
    },
  },
  (values): CommandEffect =>
    Effect.gen(function* () {
      const email = yield* configuredEmail(values.account);
      yield* checkOut(values.out, values.force);
      const imap = yield* Imap;
      const file = yield* imap.readAttachment(
        email,
        values.folder,
        values.uid,
        values.part,
      );
      const path = yield* writeAttachment(file, values.out, values.force);
      const { content: _content, ...metadata } = file;
      return json({ ...metadata, size: file.content.byteLength, path });
    }),
);

export const program: Program<CommandEffect> = {
  name: 'mailbox',
  summary:
    'mailbox: search, read, and draft email in your IMAP accounts. It never sends mail.',
  footer: [
    'Run "mailbox <command> --help" for its options. Write --option=value when a value starts with "--".',
    'Commands print JSON on stdout. Errors print {"error": {"tag", "message"}} on stderr and exit 1, or 2 for invalid arguments.',
    'Accounts live in ~/.config/mailbox/accounts.toml (MAILBOX_CONFIG overrides the path).',
  ].join('\n'),
  commands: [
    accounts,
    status,
    login,
    folders,
    search,
    read,
    attachment,
    ...draftCommands,
  ],
};
