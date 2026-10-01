import type { ProductId } from "@cubby/schemas/identifiers";
import type { ProductOwnershipEvidenceOut } from "@cubby/schemas/product";

import type { ProductOwnershipTimeline } from "~/lib/tool-timeline";
import type { Database } from "~/server/db";

import { getDb } from "../database-helpers";
import { loadProductOwnershipTimelines } from "./ownership";
import { loadProductOwnershipQuantityEvidence } from "./quantity-ledger";

export async function loadProductOwnershipEvidence(
  db: Database,
  id: ProductId,
): Promise<ProductOwnershipEvidenceOut> {
  const [timelines, quantities] = await Promise.all([
    loadProductOwnershipTimelines(getDb(db), [id]),
    loadProductOwnershipQuantityEvidence(db, [id]),
  ]);
  const timeline = timelines.get(id);
  const quantity = quantities.get(id);
  if (!timeline || !quantity)
    throw new Error("Product ownership evidence omitted its row");
  return productOwnershipEvidence(
    timeline,
    quantity.ownExpectedQuantity,
    quantity.hasKitContributions,
  );
}

/** Compare the direct interval fold only with its own Expense balance.
 * Kit projections cannot prove a dated exit from these direct intervals. */
export function productOwnershipEvidence(
  timeline: ProductOwnershipTimeline,
  directExpectedQuantity: number,
  hasKitContributions = false,
): ProductOwnershipEvidenceOut {
  const certain =
    !hasKitContributions &&
    directExpectedQuantity >= 0 &&
    timeline.confidenceLostAt === null &&
    timeline.intervals.length > 0;
  const state = certain
    ? directExpectedQuantity === 0
      ? "exited"
      : "owned"
    : "uncertain";
  return {
    state,
    acquiredAt: timeline.acquiredAt,
    exitedAt:
      state === "exited" ? (timeline.intervals.at(-1)?.end ?? null) : null,
    confidenceLostAt: timeline.confidenceLostAt,
  };
}
