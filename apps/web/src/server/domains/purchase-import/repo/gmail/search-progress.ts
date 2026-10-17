import {
  summarizeMailSearchProgress,
  type MailSearchProgress,
} from "@cubby/schemas/mailbox-research";

import type { Database } from "~/server/db";
import { loadGmailCursor } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { listGmailSyncTargets } from "~/server/domains/purchase-import/repo/gmail/targets";

/** Each mailbox with its targeted-search progress, counted over today's targets. */
export async function withMailSearchProgress<T extends { mailboxId: string }>(
  db: Database,
  ledgerPartyId: string,
  mailboxes: readonly T[],
): Promise<(T & { searches: MailSearchProgress })[]> {
  const targets = (await listGmailSyncTargets(db)).filter(
    (target) => target.ledgerPartyId === ledgerPartyId,
  );
  return Promise.all(
    mailboxes.map(async (mailbox) => {
      const { coverage } = await loadGmailCursor(db, {
        ledgerPartyId,
        mailboxId: mailbox.mailboxId,
      });
      const queries =
        targets.find((target) => target.mailboxId === mailbox.mailboxId)
          ?.scopedQueries ?? [];
      return {
        ...mailbox,
        searches: summarizeMailSearchProgress(coverage, queries),
      };
    }),
  );
}
