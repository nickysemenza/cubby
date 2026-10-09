import type { PurchaseId, VendorAccountId } from "@cubby/schemas/identifiers";
import { runEntityId, userId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb } from "~/server/repo/database-helpers";

import {
  purchasedResearchProducts,
  startProductResearch,
} from "./product-research-run";

type SweepOptions = {
  vendorAccountIds?: readonly VendorAccountId[];
  now?: Date;
  queue?: PurchaseAgentQueueProducer;
};

/** Filled facts and historic skips still need current retained proof. Transport is optional. */
export async function sweepPendingEnrichment(
  db: Database,
  options: SweepOptions = {},
) {
  const candidates = await purchasedResearchProducts(getDb(db), {
    vendorAccountIds: options.vendorAccountIds,
  });
  return launchCandidates(db, candidates, options.queue);
}

/** Caller enrolls this only after the import transaction commits. */
export async function sweepImportedPurchases(
  db: Database,
  purchaseIds: readonly PurchaseId[],
  options: Pick<SweepOptions, "queue"> = {},
) {
  if (!purchaseIds.length) return null;
  return launchCandidates(
    db,
    await purchasedResearchProducts(getDb(db), { purchaseIds }),
    options.queue,
  );
}

async function launchCandidates(
  db: Database,
  candidates: Awaited<ReturnType<typeof purchasedResearchProducts>>,
  queue?: PurchaseAgentQueueProducer,
) {
  const started: Awaited<ReturnType<typeof startProductResearch>> = [];
  const owners = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (!candidate.userId) continue;
    const key = `${candidate.ledgerPartyId}:${candidate.parentRunId ?? "scheduled"}`;
    const rows = owners.get(key) ?? [];
    rows.push(candidate);
    owners.set(key, rows);
  }
  // Each Product is claimed once in this pass; the transaction fences racing passes.
  const assigned = new Set<string>();
  for (const rows of owners.values()) {
    const owner = rows[0];
    if (!owner?.userId) continue;
    const ids = [...new Set(rows.map((row) => row.productId))].filter(
      (id) => !assigned.has(id),
    );
    for (let offset = 0; offset < ids.length; offset += 50) {
      const productIds = ids.slice(offset, offset + 50);
      const admitted = await startProductResearch(
        db,
        {
          ledgerPartyId: owner.ledgerPartyId,
          userId: userId.parse(owner.userId),
          productIds,
          parentRunId: owner.parentRunId
            ? runEntityId.parse(owner.parentRunId)
            : undefined,
          cause: "scheduled",
        },
        queue,
      );
      for (const id of productIds) assigned.add(id);
      for (const result of admitted)
        if (!started.some((prior) => prior.runId === result.runId))
          started.push(result);
    }
  }
  return { started };
}
