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
  importSourceClaim,
  importSourceOrder,
  purchase,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";
import { readRetainedMail } from "~/server/repo/retained-mail";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { assertReviewedPreparationOriginal } from "./import-orders";
import { assertMailSourceIdentityReady } from "./mail-source-identity";
import {
  recordSourceOrderObservation,
  sourceObservationIdentityMatches,
} from "./reconciliation-observations";
import {
  lockImportSourceClaimFamily,
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "./source-claim-family";

type Review = NonNullable<
  CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"]
>;
type Family = NonNullable<
  Awaited<ReturnType<typeof readImportSourceClaimFamily>>
>;
async function readReviewedPreparation(tx: DrizzleTransaction, review: Review) {
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
  if (!order) throw new Error("Reviewed preparation is unavailable.");
  return order;
}

/** A historical per-order key can join a current mailbox identity only from
 * identical owned retained bodies and headers, never from today's ledger. */
export async function canonicalizeReviewedLegacyOriginal(
  tx: DrizzleTransaction,
  association: typeof importSourceOrder.$inferSelect,
  family: Family,
  review: Review,
  actor: ActorContext,
): Promise<{ family: Family; reviewedLegacyChecksum?: string }> {
  const legacy = /^gmail:([^:]+):order:(.+)$/u.exec(family.root.externalKey);
  if (!legacy || family.root.kind !== "mail_message") return { family };
  if (association.acceptedObservationId || family.members.length !== 1)
    throw new Error(
      "Legacy source history requires separate ownership review.",
    );
  const order = await readReviewedPreparation(tx, review);
  const source = /^gmail:([^:]+):([^:]+)$/u.exec(order.sourceExternalKey);
  if (
    !source ||
    source[1]!.startsWith("legacy") ||
    source[2] !== legacy[1] ||
    order.targetPurchaseId !== association.purchaseId ||
    association.checksum !== family.root.checksum
  )
    throw new Error(
      "Reviewed preparation must establish the same legacy original and Purchase.",
    );
  const ownerId = parseEntityId("ledgerParty", family.root.ledgerPartyId);
  const original = await assertReviewedPreparationOriginal(
    databaseForTransaction(tx),
    order,
    actor,
    ownerId,
  );
  const copies = (
    await readRetainedMail(
      tx,
      { ledgerPartyIds: [ownerId], messageId: legacy[1] },
      "share",
    )
  ).filter(
    (row) =>
      row.mailboxId.startsWith("legacy:") &&
      row.rawChecksum === association.checksum,
  );
  const [historical] = copies;
  if (
    copies.length !== 1 ||
    !historical ||
    !original.sender ||
    !original.receivedAt ||
    historical.sender !== original.sender ||
    historical.subject !== original.subject ||
    historical.receivedAt?.getTime() !== original.receivedAt.getTime() ||
    historical.content.bodyText !== original.content.bodyText ||
    historical.content.bodyHtml !== original.content.bodyHtml
  )
    throw new Error(
      "Current and legacy retained originals must match exactly and unambiguously.",
    );
  await assertMailSourceIdentityReady(tx, historical);
  const extraction = importExtractionOutcome.parse(order.extraction);
  if (
    extraction.status !== "ready" ||
    extraction.candidate.orderId !== legacy[2]
  )
    throw new Error(
      "The reviewed order must match the historical per-order source key.",
    );
  const canonical = await lockImportSourceClaimFamily(tx, {
    ledgerPartyId: ownerId,
    kind: "mail_message",
    externalKey: order.sourceExternalKey,
    checksum: order.sourceChecksum,
    vendorAccountId: family.root.vendorAccountId,
    firstRunId: order.runId,
    lastRunId: order.runId,
  });
  if (
    await readSourceFamilyOrder(tx, canonical, association.orderKey, "update")
  )
    throw new Error(
      "The canonical original already has an accepted order association.",
    );
  await tx
    .update(importSourceClaim)
    .set({ canonicalClaimId: canonical.root.id })
    .where(eq(importSourceClaim.id, family.root.id));
  const joined = await readImportSourceClaimFamily(tx, canonical.root, {
    lock: "update",
  });
  if (!joined) throw new Error("Reviewed canonical source was not retained.");
  return { family: joined, reviewedLegacyChecksum: order.sourceChecksum };
}

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
  reviewedLegacyChecksum?: string,
) {
  const order = await readReviewedPreparation(tx, review);
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
    order.sourceChecksum !== (reviewedLegacyChecksum ?? association.checksum) ||
    order.evidenceChecksum !== order.sourceChecksum
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
