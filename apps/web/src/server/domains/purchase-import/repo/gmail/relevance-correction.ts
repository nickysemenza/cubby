import type { ActorContext } from "@cubby/schemas/context";
import {
  correctEmailRelevanceInput,
  correctEmailRelevanceOut,
  type CorrectEmailRelevanceInput,
  type CorrectEmailRelevanceOut,
} from "@cubby/schemas/email-actions";
import type { EmailOriginalCapture } from "@cubby/schemas/email-observations";
import {
  MAIL_ATTACHMENT_MAX_BYTES,
  MAILBOX_RESEARCH_VERSION,
} from "@cubby/schemas/mailbox-research";
import { encodeBase64 } from "@cubby/shared/base64";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransaction,
  databaseForTransaction,
  isTransaction,
} from "~/server/db/helpers";
import { email as emailTable } from "~/server/db/schema";
import {
  lockMailAttachmentUpload,
  discardMailAttachmentUpload,
} from "~/server/domains/mail/repo/mail-attachment-uploads";
import { originalChecksum } from "~/server/domains/purchase-import/repo/gmail/checksum";
import { normalizeMessage } from "~/server/domains/purchase-import/repo/gmail/normalize";
import { captureGmailOriginal } from "~/server/domains/purchase-import/repo/gmail/original-capture";
import {
  GmailApiError,
  type GmailNormalizedMessage,
  type GmailProvider,
} from "~/server/domains/purchase-import/repo/gmail/types";

import { deferClassificationRefresh } from "./admitted-source";
import { productionOrderMailAttachmentStorage } from "./attachment-storage";
import {
  recordEmailClassificationObservation,
  recordEmailRetrievalFailure,
  snapshotStoredEmailPrediction,
} from "./observations";
import {
  saveMailboxMetadata,
  upsertOrderMail,
  publishStagedOrderMailAttachment,
  reserveGmailAttachmentUploads,
} from "./persistence";
import { gmailProviderForUser } from "./provider";
import { boundedAttachment, exactMemberEmail } from "./real-time";

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
  const ownership = await exactMemberEmail(
    db,
    { mailboxId: reference.mailboxId, messageId: reference.messageId },
    actor,
    lock,
  );
  const { email } = ownership;
  if (email.id !== reference.id || email.checksum !== input.expectedChecksum)
    throw new Error("Email correction checksum or original identity changed.");
  if (await deferClassificationRefresh(db, "classification_only", email))
    throw new Error(
      "Email correction refuses an admitted or ambiguous Run assignment; its original stays frozen.",
    );
  return ownership;
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
  const originalPayloads = new Map<string, string>();
  let total = 0;
  for (const attachment of normalized.attachments) {
    const payload = attachment.dataBase64Url
      ? { data: attachment.dataBase64Url, size: attachment.size }
      : attachment.attachmentId
        ? await observedRead(db, email, () =>
            provider.getAttachment(email.messageId, attachment.attachmentId!),
          )
        : {};
    // Capture must inspect acquired encoding, not a normalized storage representation.
    if (attachment.attachmentId && payload.data !== undefined)
      originalPayloads.set(attachment.attachmentId, payload.data);
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
  return { bytes, originalPayloads };
}
export class EmailCorrectionCleanupError extends AggregateError {}

async function discardCorrectionKeys(db: Database, keys: Iterable<string>) {
  const failures: unknown[] = [];
  // A root may be a single physical connection; each deletion retains its own
  // transaction lock until storage settles, before starting the next one.
  for (const key of keys) {
    try {
      await discardMailAttachmentUpload(
        db,
        key,
        productionOrderMailAttachmentStorage,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
async function cleanNewCorrectionKeys(
  db: Database,
  created: Set<string>,
  error: Error,
): Promise<never> {
  const failures = await discardCorrectionKeys(db, created);
  if (failures.length) {
    const diagnostics = [error, ...failures]
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join("\n");
    throw new EmailCorrectionCleanupError([error, ...failures], diagnostics, {
      cause: error,
    });
  }
  throw error;
}

type PreparationDetails = {
  input: CorrectEmailRelevanceInput;
  actorUserId: ActorContext["userId"];
  connectedAccountId: string;
  email: OwnedEmail;
  normalized: GmailNormalizedMessage;
  checksum: string;
  originalCapture: EmailOriginalCapture;
  uploads: ReadonlyMap<string, { key: string; checksum: string }>;
};
const preparationDetails = new WeakMap<
  EmailRelevancePreparation,
  PreparationDetails
>();
class EmailRelevancePreparation {
  // Expose only an immutable identity; verified content never leaves this module.
  #emailId: OwnedEmail["id"];
  constructor(emailId: OwnedEmail["id"]) {
    this.#emailId = emailId;
    Object.freeze(this);
  }
  get emailId() {
    return this.#emailId;
  }
}
function verifiedPreparation(prepared: EmailRelevancePreparation) {
  const details = preparationDetails.get(prepared);
  if (!details)
    throw new Error("Email correction preparation authority does not match");
  return details;
}
export type PreparedEmailRelevanceCorrection = EmailRelevancePreparation;

/** Provider/storage preparation must precede the caller's application transaction. */
export async function prepareEmailRelevanceCorrection(
  db: Database,
  rawInput: CorrectEmailRelevanceInput,
  actor: ActorContext,
): Promise<PreparedEmailRelevanceCorrection> {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Email correction preparation requires a root database outside the application transaction",
    );
  const input = correctEmailRelevanceInput.parse(rawInput);
  const { email, connectedAccountId } = await correctionOwner(db, input, actor);
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
  const { bytes, originalPayloads } = await correctionAttachmentBytes(
    db,
    email,
    provider,
    normalized,
  );
  const originalCapture = await captureGmailOriginal({
    ledgerPartyId: email.ledgerPartyId,
    mailboxId: email.mailboxId,
    messageId: email.messageId,
    message,
    attachmentPayloads: originalPayloads,
  });
  // Refuse changes already visible after retrieval before staging external bytes;
  // publication repeats this check under the domain's parent locks.
  const { email: current, connectedAccountId: currentAccountId } =
    await correctionOwner(db, input, actor);
  if (
    current.id !== email.id ||
    currentAccountId !== connectedAccountId ||
    current.ledgerPartyId !== email.ledgerPartyId ||
    current.mailboxId !== email.mailboxId ||
    current.messageId !== email.messageId
  )
    throw new Error(
      "Email correction original owner, connected account or mailbox identity changed during retrieval.",
    );
  const uploadKeys = await reserveGmailAttachmentUploads(db, {
    orderMailId: email.orderMailId,
    attachments: normalized.attachments,
    payloads: bytes,
  });
  const uploads = new Map<string, { key: string; checksum: string }>();
  try {
    for (const attachment of normalized.attachments) {
      const key = uploadKeys.get(attachment.sourceKey);
      if (!key) continue;
      const encoded = bytes.get(attachment.sourceKey);
      if (!encoded)
        throw new Error("Prepared Email attachment has no verified bytes");
      const payload = Buffer.from(encoded, "base64");
      await withTransaction(db, async (tx) => {
        await lockMailAttachmentUpload(tx, key);
        await productionOrderMailAttachmentStorage.put(
          key,
          payload,
          attachment.mimeType,
        );
      });
      uploads.set(attachment.sourceKey, {
        key,
        checksum: await sha256Hex(payload),
      });
    }
    const prepared = new EmailRelevancePreparation(email.id);
    // Only this successful provider/storage preparation can register authority;
    // invoking the handle's reachable constructor grants none.
    preparationDetails.set(prepared, {
      input,
      actorUserId: actor.userId,
      connectedAccountId,
      email,
      normalized,
      checksum,
      originalCapture,
      uploads,
    });
    return prepared;
  } catch (error) {
    return cleanNewCorrectionKeys(
      db,
      new Set(uploadKeys.values()),
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error }),
    );
  }
}

/** Cleanup cannot remove adopted bytes, even after publication or an ambiguous commit. */
export async function discardPreparedEmailRelevanceCorrection(
  db: Database,
  prepared: PreparedEmailRelevanceCorrection,
) {
  const errors = await discardCorrectionKeys(
    db,
    [...verifiedPreparation(prepared).uploads.values()].map(({ key }) => key),
  );
  if (errors.length)
    throw new EmailCorrectionCleanupError(
      errors,
      "Prepared Email attachment cleanup failed",
      { cause: errors[0] },
    );
}

/** DB-only publication: the caller owns transaction isolation, receipt and retry. */
export async function publishPreparedEmailRelevanceCorrection(
  db: Database,
  prepared: PreparedEmailRelevanceCorrection,
  actor: ActorContext,
): Promise<CorrectEmailRelevanceOut> {
  const tx = getDb(db);
  if (!isTransaction(tx))
    throw new Error(
      "Prepared Email correction publication requires a transaction",
    );
  const details = verifiedPreparation(prepared);
  if (details.actorUserId !== actor.userId)
    throw new Error("Email correction preparation authority does not match");
  const {
    input,
    email,
    connectedAccountId,
    normalized,
    checksum,
    originalCapture,
    uploads,
  } = details;
  const { email: current, connectedAccountId: currentAccountId } =
    await correctionOwner(db, input, actor, "update");
  if (
    current.id !== email.id ||
    currentAccountId !== connectedAccountId ||
    current.ledgerPartyId !== email.ledgerPartyId ||
    current.mailboxId !== email.mailboxId ||
    current.messageId !== email.messageId
  )
    throw new Error(
      "Email correction original owner, connected account or mailbox identity changed during retrieval.",
    );
  await snapshotStoredEmailPrediction(tx, current);
  await saveMailboxMetadata(db, {
    ledgerPartyId: current.ledgerPartyId,
    mail: normalized.mail,
    checksum,
    executionPolicy: current.executionPolicy ?? "classification_only",
  });
  const orderMailId = await upsertOrderMail(
    db,
    current.ledgerPartyId,
    normalized.mail,
    checksum,
  );
  for (const { key } of [...uploads.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  ))
    await lockMailAttachmentUpload(db, key);
  for (const attachment of normalized.attachments) {
    const upload = uploads.get(attachment.sourceKey);
    await publishStagedOrderMailAttachment(db, {
      orderMailId,
      attachment,
      staged: upload ?? null,
    });
  }
  await recordEmailClassificationObservation(
    db,
    {
      emailId: current.id,
      checksum,
      classification: input.classification,
      stage: "resolution",
      reason: input.reason,
      classificationVersion: MAILBOX_RESEARCH_VERSION,
    },
    actor,
    { originalCapture },
  );
  await tx
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
}

export async function withEmailRelevancePreparation<T>(
  db: Database,
  prepared: PreparedEmailRelevanceCorrection,
  publish: (prepared: PreparedEmailRelevanceCorrection) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await publish(prepared);
  } catch (error) {
    try {
      await discardPreparedEmailRelevanceCorrection(db, prepared);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Email correction publication and cleanup failed",
        { cause: cleanup },
      );
    }
    throw error;
  }
  await discardPreparedEmailRelevanceCorrection(db, prepared);
  return result;
}

/** Explicit member correction of reviewed evidence; never import admission. */
export async function correctEmailRelevance(
  db: Database,
  input: CorrectEmailRelevanceInput,
  actor: ActorContext,
): Promise<CorrectEmailRelevanceOut> {
  const prepared = await prepareEmailRelevanceCorrection(db, input, actor);
  return withEmailRelevancePreparation(db, prepared, (value) =>
    withTransaction(db, (tx) =>
      publishPreparedEmailRelevanceCorrection(
        databaseForTransaction(tx),
        value,
        actor,
      ),
    ),
  );
}
