import { Context, Effect, Layer } from 'effect';
import { hasMail, mailAccount } from '../../../shared/accounts/account';
import { AccountConfig } from '../../../shared/accounts/config';
import { Secrets } from '../../../shared/accounts/secrets';
import { MicrosoftAuth } from '../../../shared/microsoft/auth';
import type { MailError } from '../errors/errors';
import type {
  AttachmentContent,
  CalendarMessage,
  CalendarReplyDraft,
  DraftHandle,
  DraftInput,
  DraftLocation,
  FullMessage,
  SearchOptions,
  SearchOptionsInput,
  SearchResult,
  TagDraftsInput,
  TagDraftsResult,
  UpdateDraftInput,
} from '../schemas/mail';
import { searchAccounts } from './account-search';
import { readAttachment } from './attachment';
import { readCalendarMessage } from './calendar-part';
import {
  removeDraft,
  replaceDraft,
  writeCalendarReply,
  writeDraft,
} from './draft';
import { tagDrafts } from './draft-tags';
import {
  closeClient,
  connectClient,
  type ImapLogin,
  makeClient,
  retireClient,
  type WarmClient,
  withClientSearchDeadline,
} from './imap-client';
import { listFolders, readMessage } from './imap-ops';
import { searchMailboxes } from './imap-search';
import { makeWarmClientCache } from './imap-warm-cache';
import { imapApp, imapLoginFor } from './login';

export const searchWithDedicatedClient = <Client extends WarmClient, Result>(
  account: string,
  createClient: () => Client,
  activate: (client: Client) => Effect.Effect<void, MailError>,
  search: (client: Client) => Effect.Effect<Result, MailError>,
) => {
  const client = createClient();
  return withClientSearchDeadline(
    account,
    client,
    (candidate) =>
      activate(candidate).pipe(
        Effect.andThen(Effect.suspend(() => search(candidate))),
      ),
    retireClient(client),
  );
};

// One authenticated connection per account, so a command that touches an
// account several times (such as a reply draft that reads its source first)
// logs in once. The scope finalizer closes them.
const makeConnections = Effect.gen(function* () {
  const config = yield* AccountConfig;
  const secrets = yield* Secrets;
  const microsoft = yield* MicrosoftAuth;
  const credentials = {
    get: (email: string) => secrets.getCredential('mail', email),
    store: (email: string, credential: string) =>
      secrets.setCredential('mail', email, credential),
    refresh: (email: string, refreshToken: string) =>
      microsoft.refresh(imapApp, email, refreshToken),
  } as const;
  const getMailAccount = (email: string) =>
    config.getAccount(email).pipe(Effect.flatMap(mailAccount));
  const { clientFor, closeAll } = yield* makeWarmClientCache((email: string) =>
    Effect.gen(function* () {
      const account = yield* getMailAccount(email);
      const login = yield* imapLoginFor(account, credentials);
      const client = makeClient(account, login);
      yield* connectClient(client, account);
      return client;
    }),
  );
  const searchMailbox = (email: string, options: SearchOptions) =>
    Effect.flatMap(clientFor(email), (client) =>
      searchMailboxes(client, options),
    );
  const searchMailboxWithinDeadline = (email: string, options: SearchOptions) =>
    Effect.gen(function* () {
      const account = yield* getMailAccount(email);
      const login = yield* imapLoginFor(account, credentials);
      return yield* searchWithDedicatedClient(
        email,
        () => makeClient(account, login),
        (candidate) => connectClient(candidate, account),
        (candidate) => searchMailboxes(candidate, options),
      );
    });
  yield* Effect.addFinalizer(() => closeAll);
  return {
    config,
    getMailAccount,
    clientFor,
    searchMailbox,
    searchMailboxWithinDeadline,
  } as const;
});

const makeImap = Effect.gen(function* () {
  const {
    config,
    getMailAccount,
    clientFor,
    searchMailbox,
    searchMailboxWithinDeadline,
  } = yield* makeConnections;
  return {
    verify: (email: string) => clientFor(email).pipe(Effect.asVoid),
    verifyLogin: (
      email: string,
      login: ImapLogin,
    ): Effect.Effect<void, MailError> =>
      Effect.gen(function* () {
        const account = yield* getMailAccount(email);
        const client = makeClient(account, login);
        yield* Effect.acquireUseRelease(
          Effect.succeed(client),
          (candidate) => connectClient(candidate, account),
          closeClient,
        );
      }),
    listFolders: (email: string) =>
      clientFor(email).pipe(Effect.flatMap(listFolders)),
    search: (
      email: string | undefined,
      options: SearchOptionsInput,
    ): Effect.Effect<SearchResult, MailError> =>
      searchAccounts({
        accounts: config.accounts
          .filter(hasMail)
          .map((configured) => configured.email),
        account: email,
        options,
        validateAccount: getMailAccount,
        searchMailbox,
        searchMailboxWithinDeadline,
      }),
    read: (
      email: string,
      folder: string,
      uid: number,
    ): Effect.Effect<FullMessage, MailError> =>
      clientFor(email).pipe(
        Effect.flatMap((client) => readMessage(client, folder, uid)),
      ),
    readAttachment: (
      email: string,
      folder: string,
      uid: number,
      part: string,
    ): Effect.Effect<AttachmentContent, MailError> =>
      clientFor(email).pipe(
        Effect.flatMap((client) => readAttachment(client, folder, uid, part)),
      ),
    readCalendar: (
      email: string,
      folder: string,
      uid: number,
    ): Effect.Effect<CalendarMessage, MailError> =>
      clientFor(email).pipe(
        Effect.flatMap((client) =>
          readCalendarMessage(client, email, folder, uid),
        ),
      ),
    saveCalendarReply: (
      draft: CalendarReplyDraft,
    ): Effect.Effect<DraftLocation, MailError> =>
      Effect.gen(function* () {
        const account = yield* config.getAccount(draft.account);
        const client = yield* clientFor(draft.account);
        return yield* writeCalendarReply(client, account, draft);
      }),
    saveDraft: (input: DraftInput): Effect.Effect<DraftLocation, MailError> =>
      Effect.gen(function* () {
        const account = yield* config.getAccount(input.account);
        const client = yield* clientFor(input.account);
        return yield* writeDraft(client, account, input);
      }),
    updateDraft: (
      input: UpdateDraftInput,
    ): Effect.Effect<DraftLocation, MailError> =>
      Effect.gen(function* () {
        const account = yield* config.getAccount(input.account);
        const client = yield* clientFor(input.account);
        return yield* replaceDraft(client, account, input);
      }),
    tagDrafts: (
      input: TagDraftsInput,
    ): Effect.Effect<TagDraftsResult, MailError> =>
      clientFor(input.account).pipe(
        Effect.flatMap((client) => tagDrafts(client, input)),
      ),
    deleteDraft: (handle: DraftHandle): Effect.Effect<void, MailError> =>
      clientFor(handle.account).pipe(
        Effect.flatMap((client) => removeDraft(client, handle)),
      ),
  } as const;
});

export class Imap extends Context.Service<
  Imap,
  Effect.Success<typeof makeImap>
>()('mail/Imap') {
  static readonly layer = Layer.effect(Imap, makeImap).pipe(
    Layer.provide([AccountConfig.layer, Secrets.layer, MicrosoftAuth.layer]),
  );
}
