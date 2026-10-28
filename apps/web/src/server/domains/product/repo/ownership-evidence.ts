import type { ProductId } from "@cubby/schemas/identifiers";
import type { ProductOwnershipEvidenceOut } from "@cubby/schemas/product";
import {
  isServiceProductCategory,
  type RawProductCategorySummary,
} from "@cubby/schemas/product-category-fields";

import type { ProductOwnershipTimeline } from "~/lib/tool-timeline";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";

import { loadProductOwnershipTimelines } from "./ownership";
import { loadProductOwnershipQuantityEvidence } from "./quantity-ledger";

/** Resolve one bounded page together; never fan out one history read per row. */
export async function loadProductOwnershipEvidenceBatch(
  db: Database,
  products: readonly {
    id: ProductId;
    category: RawProductCategorySummary | null;
  }[],
): Promise<Map<ProductId, ProductOwnershipEvidenceOut>> {
  const ids = products
    .filter((row) => !isServiceProductCategory(row.category))
    .map((row) => row.id);
  const timelines = await loadProductOwnershipTimelines(getDb(db), ids);
  const quantities = await loadProductOwnershipQuantityEvidence(db, ids);
  return new Map(
    products.map((row): [ProductId, ProductOwnershipEvidenceOut] => {
      if (isServiceProductCategory(row.category))
        return [
          row.id,
          {
            state: "uncertain",
            acquiredAt: null,
            exitedAt: null,
            confidenceLostAt: null,
          },
        ];
      const timeline = timelines.get(row.id);
      const quantity = quantities.get(row.id);
      if (!timeline || !quantity)
        throw new Error("Product ownership evidence omitted its row");
      return [
        row.id,
        productOwnershipEvidence(
          timeline,
          quantity.ownExpectedQuantity,
          quantity.hasKitContributions,
        ),
      ];
    }),
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
