import type { ActorContext } from "@cubby/schemas/context";
import {
  listReceiptHuntsOut,
  submitReceiptEvidenceInput,
  submitReceiptEvidenceOut,
  type SubmitReceiptEvidenceInput,
} from "@cubby/schemas/purchase-import";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";

import { extractPurchaseReceipt } from "~/server/agents/purchase-import/extract";
import type { Database } from "~/server/db";
import {
  financialTransaction,
  image,
  importHunt,
  importRun,
  ledgerParty,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { importVendorOrder } from "./writer";

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
        state: importHunt.state,
        updatedAt: importHunt.updatedAt,
        imageKey: image.key,
        imageChecksum: image.sha256,
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
      .where(eq(importHunt.id, input.huntId))
      .limit(1)
      .for("update");
    if (!row)
      throw new Error(
        "Receipt hunt or finalized image was not found for this member.",
      );
    if (!row.vendorId)
      throw new Error("Classify the receipt vendor before importing it.");
    if (row.receiptImageId) {
      const retryable =
        row.state === "receipt_failed" ||
        (row.state === "processing_receipt" &&
          row.updatedAt < new Date(Date.now() - 15 * 60_000));
      if (row.receiptImageId !== imageId && !retryable) {
        throw new Error("This receipt hunt already has different evidence.");
      }
      if (!retryable) {
        return { ...row, runId: null, newlyQueued: false };
      }
    }
    const [run] = await tx
      .insert(importRun)
      .values({
        ledgerPartyId: row.ledgerPartyId,
        vendorAccountId: row.vendorAccountId,
        trigger: "discovery",
      })
      .returning({ id: importRun.id });
    if (!run) throw new Error("Receipt import run was not created.");
    await tx
      .update(importHunt)
      .set({
        receiptImageId: imageId,
        receiptQueuedAt: new Date(),
        state: "processing_receipt",
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(importHunt.id, row.id));
    return { ...row, runId: run.id, newlyQueued: true };
  });

  if (!claimed.newlyQueued || !claimed.runId) {
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
  const vendorId = claimed.vendorId;

  try {
    const extraction = await extractPurchaseReceipt({
      db,
      runId: claimed.runId,
      imageUrl: getR2PublicUrl(claimed.imageKey),
    });
    await importVendorOrder(
      db,
      {
        runId: claimed.runId,
        ledgerPartyId: claimed.ledgerPartyId,
        vendorId,
        vendorAccountId: claimed.vendorAccountId,
        source: {
          kind: "receipt_photo",
          externalKey: `hunt:${input.huntId}:image:${input.imageId}`,
          checksum: claimed.imageChecksum,
        },
        extraction,
        primaryDocumentImageId: imageId,
        screenshotImageId: null,
      },
      actor.userId,
    );
    await withTransaction(db, async (tx) => {
      await tx
        .update(importHunt)
        .set({ state: "resolved", updatedAt: new Date() })
        .where(eq(importHunt.id, input.huntId));
      await tx
        .update(importRun)
        .set({
          status: "completed",
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(importRun.id, claimed.runId));
    });
  } catch (error) {
    await withTransaction(db, async (tx) => {
      await tx
        .update(importHunt)
        .set({
          state: "receipt_failed",
          error:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Receipt import failed",
          updatedAt: new Date(),
        })
        .where(eq(importHunt.id, input.huntId));
      await tx
        .update(importRun)
        .set({ status: "failed", endedAt: new Date(), updatedAt: new Date() })
        .where(eq(importRun.id, claimed.runId));
    });
    throw error;
  }

  return submitReceiptEvidenceOut.parse({
    huntId: input.huntId,
    imageId: input.imageId,
    queued: true,
  });
}
