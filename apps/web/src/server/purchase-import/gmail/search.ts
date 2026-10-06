import type { ActorContext } from "@cubby/schemas/context";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { orderMail } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { ingestGmailMessages } from "./ingest";
import { processOrderMails } from "./process";
import { gmailProviderForUser } from "./provider";
import { listVendorOrderMail } from "./review";
import { resolveVendorMailSearchTarget } from "./targets";
import {
  identityFromSearchTerms,
  matchesVendorSender,
} from "./vendor-identity";
import {
  defaultVendorMailSearchAfter,
  listVendorMailPage,
} from "./vendor-search";

export type VendorMailSearchProgress = (
  phase: string,
  detail: string,
  counts?: { searched?: number; skipped?: number },
) => Promise<void>;

/** Saved messages already classified at their current content; skipped on a re-scan. */
async function classifiedMessageIds(
  db: Database,
  memberId: LedgerPartyId,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const saved = await getDb(db)
    .select({
      messageId: orderMail.messageId,
      rawChecksum: orderMail.rawChecksum,
      classifiedChecksum: orderMail.classifiedChecksum,
    })
    .from(orderMail)
    .where(
      and(
        eq(orderMail.ledgerPartyId, memberId),
        inArray(orderMail.messageId, [...ids]),
      ),
    );
  return new Set(
    saved
      .filter(
        (row) =>
          row.classifiedChecksum !== null &&
          row.classifiedChecksum === row.rawChecksum,
      )
      .map((row) => row.messageId),
  );
}

export async function searchVendorOrderMail(
  db: Database,
  input: {
    vendorId: string;
    after?: string;
    pageToken?: string;
    searchTerms?: string[];
  },
  actor: ActorContext,
  onProgress: VendorMailSearchProgress = async () => undefined,
) {
  await onProgress("gmail_connect", "Connecting to Gmail");
  const target = await resolveVendorMailSearchTarget(db, input.vendorId, actor);
  const provider = await gmailProviderForUser(db, target.userId);
  const after = input.after ?? defaultVendorMailSearchAfter();
  const identity = input.searchTerms?.length
    ? identityFromSearchTerms(input.searchTerms)
    : target.identity;
  let page: Awaited<ReturnType<typeof listVendorMailPage>>;
  try {
    page = await listVendorMailPage(provider, {
      identity,
      after,
      pageToken: input.pageToken ?? null,
    });
  } catch (error) {
    throw new Error(
      `Gmail page retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const known = await classifiedMessageIds(
    db,
    target.memberId,
    page.messageIds,
  );
  const searched = page.messageIds.length;
  const skipped = page.messageIds.filter((id) => known.has(id)).length;
  await onProgress("gmail_list", `Found ${searched} messages`, {
    searched,
    skipped,
  });
  const ingested = await ingestGmailMessages(db, provider, {
    ledgerPartyId: target.memberId,
    mailboxId: "me",
    messageIds: page.messageIds.filter((id) => !known.has(id)),
    accept: (mail) => matchesVendorSender(mail.headers.from ?? "", identity),
    onMessage: (handled) =>
      onProgress(
        "gmail_fetch",
        `Checked ${skipped + handled} of ${searched} messages`,
      ),
  });
  if (ingested.saved.length > 0) {
    await onProgress(
      "mail_classify",
      `Classifying ${ingested.saved.length} messages`,
    );
    await processOrderMails(
      db,
      ingested.saved,
      undefined,
      actor.runId ?? undefined,
    );
  }
  let reviewable = 0;
  await onProgress("mail_review", "Checking order emails for review");
  if (page.messageIds.length > 0) {
    const pageWorklist = await listVendorOrderMail(
      db,
      {
        vendorId: input.vendorId,
        ledgerPartyId: target.memberShortcode,
      },
      { messageIds: page.messageIds },
    );
    reviewable = pageWorklist.items.length;
  }
  return {
    searched,
    skipped,
    reviewable,
    after,
    nextPageToken: page.nextPageToken,
  };
}
