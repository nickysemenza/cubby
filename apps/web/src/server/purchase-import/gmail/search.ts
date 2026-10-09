import type { ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";

import { startMailResearch } from "../research-run";
import { ingestGmailMessages } from "./ingest";
import { gmailProviderForUser } from "./provider";
import { resolveVendorMailSearchTarget } from "./targets";
import { identityFromSearchTerms } from "./vendor-identity";
import {
  defaultVendorMailSearchAfter,
  listVendorMailPage,
} from "./vendor-search";

export type VendorMailSearchProgress = (
  phase: string,
  detail: string,
  counts?: { searched?: number; skipped?: number },
) => Promise<void>;

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
  const provider = await gmailProviderForUser(
    db,
    target.userId,
    target.mailboxId,
  );
  const after = input.after ?? defaultVendorMailSearchAfter();
  const identity = input.searchTerms?.length
    ? identityFromSearchTerms(input.searchTerms)
    : target.identity;
  const page = await listVendorMailPage(provider, {
    identity,
    after,
    pageToken: input.pageToken ?? null,
  });
  if (!actor.runId)
    throw new Error("Scoped Gmail acquisition requires its durable Run");
  const runId = actor.runId;
  await onProgress("gmail_list", `Found ${page.messageIds.length} messages`, {
    searched: page.messageIds.length,
    skipped: 0,
  });
  const ingested = await ingestGmailMessages(db, provider, {
    ledgerPartyId: target.memberId,
    mailboxId: target.mailboxId,
    messageIds: page.messageIds,
    runId: runEntityId.parse(runId),
    onMessage: (handled) =>
      onProgress(
        "gmail_fetch",
        `Checked ${handled} of ${page.messageIds.length} messages`,
      ),
  });
  if (ingested.orderMailIds.length) {
    const results = await startMailResearch(db, {
      ledgerPartyId: target.memberId,
      userId: target.userId,
      parentRunId: runEntityId.parse(runId),
      mailboxId: target.mailboxId,
      messageIds: ingested.orderMailIds,
    });
    if (results.some((result) => result.status === "dispatch_failed"))
      throw new Error(
        "Mail research dispatch failed; replay the retained page.",
      );
  }
  return {
    searched: page.messageIds.length,
    skipped: page.messageIds.length - ingested.orderMailIds.length,
    reviewable: 0,
    after,
    nextPageToken: page.nextPageToken,
  };
}
