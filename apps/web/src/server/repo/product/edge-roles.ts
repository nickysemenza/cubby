/**
 * Product's incoming-edge roles — the single declaration this file exists to
 * be, replacing the "must agree on both" prose comment that used to sit next
 * to `deleteProducts` in `crud.ts`.
 *
 * `product` has six incoming edges (`INCOMING_EDGES.product` in
 * `entity-incoming-edges.ts`). Two are **acquisition** evidence — proof the
 * thing was actually owned at some point — one is durable **history**, and
 * three are **metadata**, which say nothing about ownership on their own:
 *
 *  - acquisition: `InventoryEntry.productId` (it's on a shelf right now) and
 *    `Expense.productId` (it was bought — the ledger's net cost and
 *    owned/sold window derive from this row, so an orphaned product would
 *    silently corrupt that derivation with no restore path).
 *  - history: `Task.subjectProductId` (work performed on the product; deleting
 *    the subject would leave that durable task history nameless).
 *  - metadata: `ProductExternalId.productId` (an ASIN says nothing about
 *    whether the thing was ever owned), `ProductUnitMappings.productId` (a
 *    hand-entered conversion is authored data, not evidence of purchase),
 *    `ProductImage.productId` (a photo/manual attachment, same reasoning).
 *
 * Two consumers read this map and build genuinely different SQL from it —
 * that's the whole point (one declaration, two shapes, no hand-kept
 * agreement):
 *
 *  - `findOrphanedProducts` (repo/problems/detectors-product.ts) — a
 *    correlated `notExists` per acquisition edge, feeding the Problems page's
 *    one-click delete.
 *  - `deleteProducts` (repo/product/crud.ts) — an `inArray` fetch +
 *    `assertNoDependents` per acquisition edge, actually blocking the delete.
 *
 * Both consumers derive `ProductRetainingEdgeKey` (below) from this map and
 * key their own `Record<ProductRetainingEdgeKey, ...>` off it, so adding or
 * dropping an acquisition/history edge here is a compile error at BOTH call sites
 * until they're updated to match — the guarantee the old prose comment could
 * only ask a reviewer to enforce by hand.
 *
 * **Residual weakness** (the same one `image.ts`'s `IMAGE_HARD_DELETE`
 * carries): declaring a retaining edge here only forces each consumer
 * to have *an entry* for it — nothing stops that entry from being wired to
 * the wrong column, or otherwise written incorrectly. Completeness of the
 * *edge set* is compile-time guaranteed; correctness of each edge's SQL is
 * not. The `PRODUCT_EDGE_ROLES backstop` describe block in
 * `product.integration.test.ts` is the cheap regression test that buys back
 * some of that: it exercises every acquisition/history edge (must block
 * delete) and every metadata edge (must cascade-soft-delete on a successful delete)
 * against a real product, so a wrong-column or silently-dropped predicate
 * fails a test instead of shipping.
 */

import type { AppErrorReason } from "@cubby/shared";
import type { IncomingEdgeKey } from "~/server/db/entity-incoming-edges";

export type ProductEdgeRole =
  | {
      kind: "acquisition" | "history";
      /** The `AppErrorReason` `deleteProducts` throws when this edge is live. */
      reason: AppErrorReason;
      /** Plural noun phrase naming the dependent rows, for the delete-guard's
       *  error message (e.g. "inventory entries", "expenses"). */
      label: string;
    }
  | {
      kind: "metadata";
      /** Why this edge is NOT evidence the product was ever owned. */
      why: string;
    };

export const PRODUCT_EDGE_ROLES = {
  "InventoryEntry.productId": {
    kind: "acquisition",
    reason: "PRODUCT_HAS_INVENTORY",
    label: "inventory entries",
  },
  "Expense.productId": {
    kind: "acquisition",
    reason: "PRODUCT_HAS_EXPENSES",
    label: "expenses",
  },
  "Task.subjectProductId": {
    kind: "history",
    reason: "PRODUCT_HAS_TASKS",
    label: "tasks referencing them",
  },
  "ProductExternalId.productId": {
    kind: "metadata",
    why: "an external id (e.g. an ASIN) says nothing about whether the product was ever owned",
  },
  "ProductUnitMappings.productId": {
    kind: "metadata",
    why: "a hand-entered conversion is authored data, not evidence of purchase",
  },
  "ProductImage.productId": {
    kind: "metadata",
    why: "a photo or manual attachment says nothing about ownership",
  },
} as const satisfies Record<IncomingEdgeKey<"product">, ProductEdgeRole>;

/**
 * The subset of `product`'s incoming edges whose role retains the product —
 * acquisition evidence or durable work history. Derived from
 * {@link PRODUCT_EDGE_ROLES}, not hand-listed, so it can't drift from it.
 * Both `findOrphanedProducts` and `deleteProducts` key their own per-edge SQL
 * map off this type.
 */
export type ProductRetainingEdgeKey = {
  [K in keyof typeof PRODUCT_EDGE_ROLES]: (typeof PRODUCT_EDGE_ROLES)[K]["kind"] extends
    | "acquisition"
    | "history"
    ? K
    : never;
}[keyof typeof PRODUCT_EDGE_ROLES];
