import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  importExtractionOutcome,
  importSourceIdentity,
  type CommitAcceptedSourceOrderReconciliationInput,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  importPreparedOrder,
  importSourceOrder,
  purchase,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { assertReviewedPreparationOriginal } from "./import-orders";
import {
  recordSourceOrderObservation,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import type { readImportSourceClaimFamily } from "./source-claim-family";

/** Current member review creates new provenance; the unknown historical
 * originalOrder is never filled from today's Expenses or this preparation. */
export async function recordReviewedOriginal(
  tx: DrizzleTransaction,
  association: typeof importSourceOrder.$inferSelect,
  family: NonNullable<Awaited<ReturnType<typeof readImportSourceClaimFamily>>>,
  review: NonNullable<
    CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"]
  >,
  actor: ActorContext,
) {
  const runId = await resolveOrThrow(tx, "run", review.run);
  const [order] = await tx
    .select()
    .from(importPreparedOrder)
    .where(
      and(
        eq(importPreparedOrder.runId, runId),
        eq(importPreparedOrder.stableOrderId, review.stableOrderId),
      ),
    )
    .for("share");
  const [target] = await tx
    .select()
    .from(purchase)
    .where(and(eq(purchase.id, association.purchaseId), notDeleted(purchase)))
    .for("update");
  if (
    !order ||
    !target ||
    order.targetPurchaseId !== target.id ||
    !order.vendorId ||
    !(await sourceObservationIdentityMatches(
      tx,
      "vendor",
      order.vendorId,
      target.vendorId,
    )) ||
    order.sourceKind !== family.root.kind ||
    order.sourceExternalKey !== family.root.externalKey ||
    order.sourceChecksum !== association.checksum ||
    order.evidenceChecksum !== association.checksum
  )
    throw new Error(
      "Reviewed preparation must name this Purchase and its unchanged canonical original.",
    );
  await assertReviewedPreparationOriginal(
    databaseForTransaction(tx),
    order,
    actor,
    parseEntityId("ledgerParty", family.root.ledgerPartyId),
  );
  const extraction = importExtractionOutcome.parse(order.extraction);
  if (
    extraction.status !== "ready" ||
    !extraction.candidate ||
    extraction.candidate.orderId !== target.orderId
  )
    throw new Error(
      "Reviewed original must establish the existing order identity.",
    );
  return recordSourceOrderObservation(
    tx,
    {
      sourceClaimId: association.sourceClaimId,
      orderKey: association.orderKey,
      purchaseId: target.id,
    },
    {
      runId: order.runId,
      vendorId: target.vendorId,
      source: importSourceIdentity.parse({
        kind: order.sourceKind,
        externalKey: order.sourceExternalKey,
        checksum: order.sourceChecksum,
      }),
      extraction,
      primaryDocumentImageId: order.primaryDocumentImageId,
      screenshotImageId: order.screenshotImageId,
    },
  );
}
