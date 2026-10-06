import type { Database } from "~/server/db";

import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { normalizeMessage } from "./normalize";
import { storeOrderMailAttachment, upsertOrderMail } from "./persistence";
import {
  GmailApiError,
  type GmailOrderMail,
  type GmailProvider,
} from "./types";

export type GmailIngestOutcome = {
  /** Saved (or re-saved) message ids, in the order they were processed. */
  saved: string[];
  /** Listed, then gone from Gmail before they were fetched. */
  deleted: string[];
  /** Fetched, but `accept` declined them; nothing was written. */
  rejected: string[];
};

/**
 * Fetch and save messages one at a time: each message's row, then each of its
 * attachments streamed to object storage before the next is fetched. Peak
 * memory is one message plus one attachment however many ids a batch names.
 * Replaying the same ids is safe — rows upsert and stored bytes are skipped
 * before any fetch — so a Workflow step can retry a partly saved batch.
 */
export async function ingestGmailMessages(
  db: Database,
  provider: GmailProvider,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageIds: readonly string[];
    accept?: (mail: GmailOrderMail) => boolean;
    storage?: OrderMailAttachmentStorage;
    /** Called after each message, saved or not, with how many are done. */
    onMessage?: (handled: number) => Promise<void>;
  },
): Promise<GmailIngestOutcome> {
  const storage = input.storage ?? productionOrderMailAttachmentStorage;
  const outcome: GmailIngestOutcome = { saved: [], deleted: [], rejected: [] };
  let handled = 0;
  const done = async () => {
    handled += 1;
    await input.onMessage?.(handled);
  };
  for (const messageId of new Set(input.messageIds)) {
    let message;
    try {
      message = await provider.getMessage(messageId);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        outcome.deleted.push(messageId);
        await done();
        continue;
      }
      throw error;
    }
    const normalized = normalizeMessage(input.mailboxId, message);
    if (input.accept && !input.accept(normalized.mail)) {
      outcome.rejected.push(messageId);
      await done();
      continue;
    }
    const orderMailId = await upsertOrderMail(
      db,
      input.ledgerPartyId,
      normalized.mail,
    );
    for (const attachment of normalized.attachments) {
      await storeOrderMailAttachment(db, {
        orderMailId,
        attachment,
        storage,
        fetchData: async () =>
          attachment.dataBase64Url ??
          (attachment.attachmentId
            ? (await provider.getAttachment(messageId, attachment.attachmentId))
                .data
            : undefined),
      });
    }
    outcome.saved.push(messageId);
    await done();
  }
  return outcome;
}
