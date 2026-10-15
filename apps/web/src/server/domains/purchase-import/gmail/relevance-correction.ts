import type { ActorContext } from "@cubby/schemas/context";
import {
  correctEmailRelevanceInput,
  correctEmailRelevanceOut,
  type CorrectEmailRelevanceInput,
  type CorrectEmailRelevanceOut,
} from "@cubby/schemas/email-actions";
import {
  MAIL_ATTACHMENT_MAX_BYTES,
  MAILBOX_RESEARCH_VERSION,
} from "@cubby/schemas/mailbox-research";
import { encodeBase64 } from "@cubby/shared/base64";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransaction,
  databaseForTransaction,
} from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import { email as emailTable, orderMailAttachment } from "~/server/db/schema";

import { deferClassificationRefresh } from "./admitted-source";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import {
  recordEmailClassificationObservation,
  recordEmailRetrievalFailure,
  snapshotStoredEmailPrediction,
} from "./observations";
import {
  saveMailboxMetadata,
  upsertOrderMail,
  storeOrderMailAttachment,
  reserveGmailAttachmentUploads,
} from "./persistence";
import { gmailProviderForUser } from "./provider";
import { boundedAttachment, exactMemberEmail } from "./real-time";
import {
  GmailApiError,
  type GmailNormalizedMessage,
  type GmailProvider,
} from "./types";

type OwnedEmail = typeof emailTable.$inferSelect;
async function correctionOwner(
  db: Database,
  input: CorrectEmailRelevanceInput,
  actor: ActorContext,
  lock?: "update",
) {
  if (actor.runId)
    throw new Error("Only a member without a Run can correct Email relevance.");
  const [reference] = await getDb(db)
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.shortcode, input.id),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  if (!reference)
    throw new Error("No live Gmail Email matches this correction.");
  const email = await exactMemberEmail(
    db,
    { mailboxId: reference.mailboxId, messageId: reference.messageId },
    actor,
    lock,
  );
  if (email.id !== reference.id || email.checksum !== input.expectedChecksum)
    throw new Error("Email correction checksum or original identity changed.");
  if (await deferClassificationRefresh(db, "classification_only", email))
    throw new Error(
      "Email correction refuses an admitted or ambiguous Run assignment; its original stays frozen.",
    );
  return email;
}
async function observedRead<T>(
  db: Database,
  email: OwnedEmail,
  read: () => Promise<T>,
) {
  try {
    return await read();
  } catch (error) {
    await recordEmailRetrievalFailure(db, {
      ledgerPartyId: email.ledgerPartyId,
      mailboxId: email.mailboxId,
      messageId: email.messageId,
      httpStatus: error instanceof GmailApiError ? error.status : null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
function validateCorrectionOriginal(normalized: GmailNormalizedMessage) {
  if (
    normalized.mail.labelIds.some(
      (label) => label === "SPAM" || label === "TRASH",
    )
  )
    throw new Error("Email correction original is excluded in Spam or Trash.");
  const body = [normalized.mail.bodyText ?? "", normalized.mail.bodyHtml ?? ""];
  if (
    body.reduce(
      (sum, value) => sum + new TextEncoder().encode(value).byteLength,
      0,
    ) > MAIL_ATTACHMENT_MAX_BYTES
  )
    throw new Error(
      "Email correction original body exceeds the combined 3 MiB byte bound.",
    );
  if (
    normalized.attachments.reduce((sum, part) => sum + part.size, 0) >
    MAIL_ATTACHMENT_MAX_BYTES
  )
    throw new Error(
      "Email correction original attachments exceed the combined 3 MiB byte bound.",
    );
  if (!body.some((value) => value.trim()) && !normalized.attachments.length)
    throw new Error(
      "Email correction original has no available body or attachment bytes.",
    );
}
async function correctionAttachmentBytes(
  db: Database,
  email: OwnedEmail,
  provider: GmailProvider,
  normalized: GmailNormalizedMessage,
) {
  const bytes = new Map<string, string>();
  let total = 0;
  for (const attachment of normalized.attachments) {
    const payload = attachment.dataBase64Url
      ? { data: attachment.dataBase64Url, size: attachment.size }
      : attachment.attachmentId
        ? await observedRead(db, email, () =>
            provider.getAttachment(email.messageId, attachment.attachmentId!),
          )
        : {};
    const decoded = boundedAttachment(attachment, payload);
    if (!decoded.byteLength)
      throw new Error("Email correction attachment has no available bytes.");
    total += decoded.byteLength;
    if (total > MAIL_ATTACHMENT_MAX_BYTES)
      throw new Error(
        "Email correction attachments exceed the combined 3 MiB byte bound.",
      );
    bytes.set(attachment.sourceKey, encodeBase64(decoded));
  }
  return bytes;
}
async function cleanNewCorrectionKeys(
  created: Set<string>,
  error: Error,
): Promise<never> {
  const cleanup = await Promise.allSettled(
    [...created].map((key) => productionOrderMailAttachmentStorage.delete(key)),
  );
  const failures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    const diagnostics = [error, ...failures]
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join("\n");
    throw new AggregateError([error, ...failures], diagnostics);
  }
  throw error;
}

/** Explicit member correction of reviewed evidence; never import admission. */
export async function correctEmailRelevance(
  db: Database,
  rawInput: CorrectEmailRelevanceInput,
  actor: ActorContext,
): Promise<CorrectEmailRelevanceOut> {
  const input = correctEmailRelevanceInput.parse(rawInput);
  const email = await correctionOwner(db, input, actor);
  const provider = await observedRead(db, email, () =>
    gmailProviderForUser(db, actor.userId, email.mailboxId),
  );
  const message = await observedRead(db, email, () =>
    provider.getMessage(email.messageId),
  );
  if (message.id !== email.messageId)
    throw new Error("Email correction provider original identity changed.");
  const normalized = normalizeMessage(email.mailboxId, message);
  validateCorrectionOriginal(normalized);
  const checksum = await originalChecksum(normalized);
  if (checksum !== input.reviewedChecksum)
    throw new Error(
      "Email correction original changed from the reviewed checksum proof.",
    );
  const bytes = await correctionAttachmentBytes(
    db,
    email,
    provider,
    normalized,
  );
  const uploadKeys = await reserveGmailAttachmentUploads(db, {
    orderMailId: email.orderMailId,
    attachments: normalized.attachments,
    payloads: bytes,
  });
  const created = new Set<string>();
  let committed = false;
  try {
    return await withTransaction(db, async (tx) => {
      const txDb = databaseForTransaction(tx);
      await runAfterCommit(txDb, async () => {
        committed = true;
      });
      const current = await correctionOwner(txDb, input, actor, "update");
      if (
        current.id !== email.id ||
        current.ledgerPartyId !== email.ledgerPartyId ||
        current.mailboxId !== email.mailboxId ||
        current.messageId !== email.messageId
      )
        throw new Error(
          "Email correction original owner or mailbox identity changed during retrieval.",
        );
      const originals = current.orderMailId
        ? await getDb(txDb)
            .select()
            .from(orderMailAttachment)
            .where(eq(orderMailAttachment.orderMailId, current.orderMailId))
        : [];
      const protectedKeys = new Set(
        originals.flatMap((row) =>
          row.pendingObjectKey ? [row.pendingObjectKey] : [],
        ),
      );
      const storage: OrderMailAttachmentStorage = {
        ...productionOrderMailAttachmentStorage,
        put: async (key, payload, contentType) => {
          if (!protectedKeys.has(key)) created.add(key);
          await productionOrderMailAttachmentStorage.put(
            key,
            payload,
            contentType,
          );
        },
      };
      await snapshotStoredEmailPrediction(tx, current);
      await saveMailboxMetadata(txDb, {
        ledgerPartyId: current.ledgerPartyId,
        mail: normalized.mail,
        checksum,
        executionPolicy: current.executionPolicy ?? "classification_only",
      });
      const orderMailId = await upsertOrderMail(
        txDb,
        current.ledgerPartyId,
        normalized.mail,
        checksum,
      );
      for (const attachment of normalized.attachments)
        await storeOrderMailAttachment(txDb, {
          orderMailId,
          attachment,
          storage,
          uploadKey: uploadKeys.get(attachment.sourceKey),
          fetchData: async () => bytes.get(attachment.sourceKey),
        });
      await recordEmailClassificationObservation(
        txDb,
        {
          emailId: current.id,
          checksum,
          classification: input.classification,
          stage: "resolution",
          reason: input.reason,
          classificationVersion: MAILBOX_RESEARCH_VERSION,
        },
        actor,
      );
      await getDb(txDb)
        .update(emailTable)
        .set({
          checksum,
          classification: input.classification,
          classificationStage: "resolution",
          classificationReason: input.reason,
          classificationVersion: MAILBOX_RESEARCH_VERSION,
          contentClearedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(emailTable.id, current.id));
      return correctEmailRelevanceOut.parse({
        id: input.id,
        checksum,
        classification: input.classification,
        originalAvailable: true,
      });
    });
  } catch (error) {
    if (committed) throw error;
    return cleanNewCorrectionKeys(
      created,
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error }),
    );
  }
}
