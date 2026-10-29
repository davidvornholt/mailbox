import { Effect } from 'effect';
import type { Account } from '../../../shared/accounts/account';
import { OutlookReadOnlyError } from '../errors/errors';
import { isCalDavHref } from './calendar-source';

const refusal = (account: Account, reason: string) =>
  Effect.fail(
    new OutlookReadOnlyError({
      account: account.email,
      message: `Outlook calendars are read-only in pim for now: ${reason}`,
    }),
  );

// pim reads Outlook calendars through Microsoft Graph but does not write to
// them yet. It refuses any write for an account whose only calendars are in
// Outlook, and a change to the event at href when that is an Outlook event.
export const refuseOutlookWrite = (
  account: Account,
  href?: string,
): Effect.Effect<void, OutlookReadOnlyError> => {
  if (account.graph === undefined) {
    return Effect.void;
  }
  if (account.dav === undefined) {
    return refusal(
      account,
      `${account.email} has only an [accounts.graph] table, so pim cannot create, change or delete its events or answer or import invitations into its calendars`,
    );
  }
  return href === undefined || isCalDavHref(href)
    ? Effect.void
    : refusal(
        account,
        `${href} is an Outlook event of ${account.email}, so pim cannot change or delete it. pim writes only to the calendars of [accounts.dav], whose hrefs are paths`,
      );
};
