import type { ActorContext } from "@cubby/schemas/context";
import {
  listReceiptHuntsOut,
  submitReceiptEvidenceInput,
  submitReceiptEvidenceOut,
  type SubmitReceiptEvidenceInput,
} from "@cubby/schemas/purchase-import";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialTransaction,
  image,
  importHunt,
  importRun,
  ledgerParty,
  user,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { mintImportRunPublicId } from "./run-identifiers";

/**
 * A hunt—not a particular upload—is the durable receipt source. A retry may
 * replace an unreadable photo, but it must refresh the same source claim so a
 * redeploy or a second attempt cannot manufacture a second Purchase.
 */
export const receiptHuntSourceIdentity = (input: {
  huntId: string;
  checksum: string;
}) => ({
  kind: "receipt_photo" as const,
  externalKey: `hunt:${input.huntId}`,
  checksum: input.checksum,
});

export async function loadReceiptEvidenceForRun(db: Database, runId: string) {
  const [row] = await getDb(db)
    .select({
      huntId: importHunt.id,
      imageId: image.shortcode,
      imageKey: image.key,
      checksum: image.sha256,
    })
    .from(importHunt)
    .innerJoin(
      image,
      and(
        eq(image.id, importHunt.receiptImageId),
        eq(image.status, "UPLOADED"),
        isNotNull(image.sha256),
        notDeleted(image),
      ),
    )
    .where(
      and(
        eq(importHunt.receiptRunId, runId),
        eq(importHunt.state, "processing_receipt"),
      ),
    )
    .limit(1);
  if (!row?.checksum) return null;
  return {
    huntId: row.huntId,
    imageId: row.imageId,
    imageUrl: getR2PublicUrl(row.imageKey),
    source: receiptHuntSourceIdentity({
      huntId: row.huntId,
      checksum: row.checksum,
    }),
    evidenceChecksum: row.checksum,
  };
}

export async function listReceiptHunts(db: Database, actor: ActorContext) {
  const rows = await getDb(db)
    .select({
      id: importHunt.id,
      transactionDate: financialTransaction.transactionDate,
      merchant: financialTransaction.merchant,
      amount: financialTransaction.amount,
    })
    .from(importHunt)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importHunt.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(
      financialTransaction,
      and(
        eq(financialTransaction.id, importHunt.financialTransactionId),
        notDeleted(financialTransaction),
      ),
    )
    .where(
      or(
        inArray(importHunt.state, ["receipt_required", "receipt_failed"]),
        and(
          eq(importHunt.state, "processing_receipt"),
          lt(importHunt.updatedAt, new Date(Date.now() - 15 * 60_000)),
        ),
      ),
    )
    .orderBy(importHunt.dateFrom);

  return listReceiptHuntsOut.parse({
    items: rows.map((row) => ({
      id: row.id,
      transactionDate: row.transactionDate,
      merchant: row.merchant,
      amountInCents: Math.round(Math.abs(row.amount) * 100),
    })),
  });
}

export async function submitReceiptEvidence(
  db: Database,
  rawInput: SubmitReceiptEvidenceInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
) {
  const input = submitReceiptEvidenceInput.parse(rawInput);
  const imageId = await resolveOrThrow(db, "image", input.imageId);
  const claimed = await withTransaction(db, async (tx) => {
    const [row] = await tx
      .select({
        id: importHunt.id,
        ledgerPartyId: importHunt.ledgerPartyId,
        vendorId: importHunt.vendorId,
        vendorAccountId: importHunt.vendorAccountId,
        receiptImageId: importHunt.receiptImageId,
        receiptRunId: importHunt.receiptRunId,
        state: importHunt.state,
        updatedAt: importHunt.updatedAt,
        imageChecksum: image.sha256,
        actorUserId: ledgerParty.userId,
        actorName: user.name,
        actorEmail: user.email,
        actorLedgerPartyShortcode: ledgerParty.shortcode,
        actorLedgerPartyName: ledgerParty.name,
        actorLedgerPartyKind: ledgerParty.kind,
      })
      .from(importHunt)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, importHunt.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .innerJoin(
        image,
        and(
          eq(image.id, imageId),
          eq(image.status, "UPLOADED"),
          isNotNull(image.sha256),
          notDeleted(image),
        ),
      )
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .where(eq(importHunt.id, input.huntId))
      .limit(1)
      .for("update");
    if (!row)
      throw new Error(
        "Receipt hunt or finalized image was not found for this member.",
      );
    if (!row.vendorId)
      throw new Error("Classify the receipt vendor before importing it.");
    if (!row.actorUserId)
      throw new Error("Receipt party has no controlling member.");
    if (row.receiptImageId) {
      const retryable =
        row.state === "receipt_failed" ||
        (row.state === "processing_receipt" &&
          row.updatedAt < new Date(Date.now() - 15 * 60_000));
      if (row.receiptImageId !== imageId && !retryable) {
        throw new Error("This receipt hunt already has different evidence.");
      }
      if (!retryable) {
        if (!row.receiptRunId)
          throw new Error(
            "Receipt evidence is processing without an import run.",
          );
        const [existingRun] = await tx
          .select({ id: importRun.id, publicId: importRun.publicId })
          .from(importRun)
          .where(eq(importRun.id, row.receiptRunId))
          .limit(1);
        if (!existingRun)
          throw new Error("Receipt import run could not be resumed.");
        return {
          ...row,
          runId: existingRun.id,
          publicId: existingRun.publicId,
          shouldEnqueue: true,
        };
      }
    }
    const runId = crypto.randomUUID();
    const [run] = await tx
      .insert(importRun)
      .values({
        id: runId,
        publicId: mintImportRunPublicId(),
        ledgerPartyId: row.ledgerPartyId,
        actorUserId: row.actorUserId,
        actorName: row.actorName,
        actorEmail: row.actorEmail,
        actorLedgerPartyShortcode: row.actorLedgerPartyShortcode,
        actorLedgerPartyName: row.actorLedgerPartyName,
        actorLedgerPartyKind: row.actorLedgerPartyKind,
        vendorAccountId: row.vendorAccountId,
        vendorId: row.vendorId,
        predecessorRunId: row.receiptRunId,
        trigger: "discovery",
        agentSessionId: `import-run:${runId}`,
      })
      .returning({ id: importRun.id });
    if (!run) throw new Error("Receipt import run was not created.");
    await tx
      .update(importHunt)
      .set({
        receiptImageId: imageId,
        receiptRunId: run.id,
        receiptQueuedAt: new Date(),
        state: "processing_receipt",
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(importHunt.id, row.id));
    const [createdRun] = await tx
      .select({ publicId: importRun.publicId })
      .from(importRun)
      .where(eq(importRun.id, run.id))
      .limit(1);
    if (!createdRun) throw new Error("Receipt import run was not found.");
    return {
      ...row,
      runId: run.id,
      publicId: createdRun.publicId,
      shouldEnqueue: true,
    };
  });

  if (!claimed.shouldEnqueue || !claimed.runId || !claimed.publicId) {
    return submitReceiptEvidenceOut.parse({
      huntId: input.huntId,
      imageId: input.imageId,
      queued: false,
    });
  }
  if (!claimed.imageChecksum)
    throw new Error("Finalized receipt image is missing its checksum.");
  if (!claimed.vendorId)
    throw new Error("Classify the receipt vendor before importing it.");
  await queue.send({
    version: 1,
    runId: claimed.runId,
    publicId: claimed.publicId,
    eventId: `receipt:${input.huntId}:${claimed.imageChecksum}`,
    type: "start_or_resume",
  });

  return submitReceiptEvidenceOut.parse({
    huntId: input.huntId,
    imageId: input.imageId,
    queued: true,
  });
}
