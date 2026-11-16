import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  importSourceKind,
  proposedImportFix,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { notDeleted, withTransaction } from "~/server/db/helpers";
import { ledgerParty, sourceOrderObservation } from "~/server/db/schema";
import {
  reconciliationFingerprint,
  sourceObservationOwnsPurchase,
} from "~/server/domains/purchase-import/repo/reconciliation-observations";
import {
  lockImportSourceClaimFamily,
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "~/server/domains/purchase-import/repo/source-claim-family";
import { publishRunFinding } from "~/server/domains/run/repo/run-finding";
import { enterWriteTransaction } from "~/server/kernel/gate";

/** A held capture enters the existing member financial review without accepting its money. */
export async function publishSourceOrderReconciliation(
  db: Database,
  input: { observationId: string; purchaseId: string; runId: RunId },
  actor: ActorContext,
) {
  return withTransaction(db, async (tx) => {
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
    const [owned] = await tx
      .select({ observation: sourceOrderObservation })
      .from(sourceOrderObservation)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, sourceOrderObservation.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(eq(sourceOrderObservation.id, input.observationId));
    const observation = owned?.observation;
    const purchaseId = parseEntityId("purchase", input.purchaseId);
    if (
      !observation?.ledgerPartyId ||
      !(await sourceObservationOwnsPurchase(tx, observation, purchaseId))
    )
      throw new Error(
        "The held source no longer belongs to this member and Purchase",
      );
    const source = {
      kind: importSourceKind.parse(observation.sourceKind),
      externalKey: observation.sourceExternalKey,
      checksum: observation.checksum,
    };
    const identity = {
      ledgerPartyId: observation.ledgerPartyId,
      kind: source.kind,
      externalKey: source.externalKey,
    };
    const family =
      (await readImportSourceClaimFamily(tx, identity, {
        lock: "update",
        writable: true,
      })) ??
      (await lockImportSourceClaimFamily(tx, {
        ...identity,
        checksum: observation.checksum,
        firstRunId: observation.runId ?? input.runId,
        lastRunId: input.runId,
        vendorAccountId: null,
      }));
    const accepted = await readSourceFamilyOrder(
      tx,
      family,
      observation.orderKey,
      "update",
    );
    if (accepted && accepted.association.purchaseId !== purchaseId)
      throw new Error(
        "The source review changed its accepted Purchase identity",
      );
    const evidenceFingerprint = await reconciliationFingerprint({
      source,
      orderKey: observation.orderKey,
      observationId: observation.id,
      purchaseId,
    });
    return publishRunFinding(tx, {
      runId: input.runId,
      ledgerPartyId: observation.ledgerPartyId,
      entityKind: "purchase",
      entityId: purchaseId,
      kind: "source_financial_changed",
      summary: "Review source evidence against recorded spending.",
      evidenceFingerprint,
      proposedFix: proposedImportFix.parse({
        kind: "reconcile_source_order",
        purchaseId,
        source,
        orderKey: observation.orderKey,
        acceptedChecksum: accepted?.association.checksum ?? null,
        proposedExtraction: observation.extraction,
        observationId: observation.id,
        reviewedFingerprint: evidenceFingerprint,
      }),
    });
  });
}
