import { Effect } from 'effect';
import type { MailError } from '../errors/errors';
import type {
  AttachmentContent,
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
import { MailConfig } from './config';
import { removeDraft, replaceDraft, writeDraft } from './draft';
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
import { imapLoginFor } from './login';
import { MicrosoftAuth } from './microsoft-auth';
import { Secrets } from './secrets';

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

// One IMAP service instance keeps one authenticated connection per account, so
// a command that touches an account several times (such as a reply draft that
// reads its source first) logs in once. The scope finalizer closes them.
export class Imap extends Effect.Service<Imap>()('mail/Imap', {
  dependencies: [MailConfig.Default, Secrets.Default, MicrosoftAuth.Default],
  scoped: Effect.gen(function* () {
    const config = yield* MailConfig;
    const secrets = yield* Secrets;
    const microsoft = yield* MicrosoftAuth;
    const credentials = {
      get: secrets.getCredential,
      store: secrets.setCredential,
      refresh: microsoft.refresh,
    } as const;
    const { clientFor, closeAll } = yield* makeWarmClientCache(
      (email: string) =>
        Effect.gen(function* () {
          const account = yield* config.getAccount(email);
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
    const searchMailboxWithinDeadline = (
      email: string,
      options: SearchOptions,
    ) =>
      Effect.gen(function* () {
        const account = yield* config.getAccount(email);
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
      verify: (email: string) => clientFor(email).pipe(Effect.asVoid),
      verifyLogin: (
        email: string,
        login: ImapLogin,
      ): Effect.Effect<void, MailError> =>
        Effect.gen(function* () {
          const account = yield* config.getAccount(email);
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
          accounts: config.emails,
          account: email,
          options,
          validateAccount: config.getAccount,
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
  }),
}) {}
