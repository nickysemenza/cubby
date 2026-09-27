import type { ActorContext } from "@cubby/schemas/context";

import { getGmailOAuthCredentials } from "~/server/cf-env";
import type { Database } from "~/server/db";

import {
  createBetterAuthGmailAccountStore,
  persistGmailSyncResult,
} from "./persistence";
import { processOrderMails } from "./process";
import { listVendorOrderMail } from "./review";
import { resolveVendorMailSearchTarget } from "./targets";
import { createGmailProviderFactory } from "./tokens";
import { loadVendorMailPage } from "./vendor-search";

export async function searchVendorOrderMail(
  db: Database,
  input: {
    vendorId: string;
    after?: string;
    pageToken?: string;
  },
  actor: ActorContext,
) {
  const target = await resolveVendorMailSearchTarget(db, input.vendorId, actor);
  const worker = getGmailOAuthCredentials();
  const environment = worker ? null : (await import("~/env")).env;
  const clientId = worker?.clientId ?? environment?.GOOGLE_CLIENT_ID;
  const clientSecret =
    worker?.clientSecret ?? environment?.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("Google OAuth is not configured for Gmail search.");
  const provider = await createGmailProviderFactory({
    store: createBetterAuthGmailAccountStore(db),
    clientId,
    clientSecret,
  })(target.userId);
  const after =
    input.after ??
    new Date(Date.now() - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "/");
  const page = await loadVendorMailPage(provider, {
    identity: target.identity,
    after,
    pageToken: input.pageToken ?? null,
  });
  if (page.messages.length > 0) {
    const persisted = await persistGmailSyncResult(db, {
      ledgerPartyId: target.memberId,
      advanceCursor: false,
      result: {
        mode: "bootstrap",
        reason: "first_sync",
        cursor: { historyId: null },
        messages: page.messages,
        events: [],
        attachments: page.attachments,
      },
    });
    await processOrderMails(db, persisted.messageIds, page.attachments);
  }
  const worklist = await listVendorOrderMail(db, {
    vendorId: input.vendorId,
    ledgerPartyId: target.memberShortcode,
  });
  return {
    searched: page.searched,
    reviewable: worklist.items.length,
    after,
    nextPageToken: page.nextPageToken,
  };
}
