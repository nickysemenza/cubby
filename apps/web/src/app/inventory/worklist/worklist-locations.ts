/** A worklist scope the recount session can be entered with. */
export const RECOUNT_WORKLISTS = ["shelf-disagrees"] as const;
export type RecountWorklist = (typeof RECOUNT_WORKLISTS)[number];

/** Persisted-pass scope key: distinct from every location shortcode. */
export const worklistScopeKey = (worklist: RecountWorklist) =>
  `worklist:${worklist}`;

export const WORKLIST_TITLES = {
  "shelf-disagrees": "Shelf disagrees",
} as const satisfies Record<RecountWorklist, string>;

/** The slice of a product list row the location resolution reads. */
interface HeldProduct {
  inventoryEntry: ReadonlyArray<{
    placement: string;
    location: { id: string };
  }>;
}

/**
 * The locations a recount of these products has to visit: every location
 * holding a stock entry of any of them.
 *
 * Stock placement only — the recount snapshot is stock-only
 * (`placement: "stock"`), so a fixture installed somewhere is not a bin you
 * could count and would produce a stop with nothing to confirm. A product held
 * only as a bin in service, or nowhere, contributes no stop: there is no shelf
 * row to count.
 */
export function locationIdsHoldingProducts(
  products: readonly HeldProduct[],
): Set<string> {
  const ids = new Set<string>();
  for (const product of products) {
    for (const entry of product.inventoryEntry) {
      if (entry.placement === "stock") ids.add(entry.location.id);
    }
  }
  return ids;
}
