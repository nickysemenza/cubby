/**
 * Product's delete policy, and the retaining-edge set derived from the shared
 * edge semantics — replacing the "must agree on both" prose comment that used
 * to sit next to `deleteProducts` in `crud.ts`.
 *
 * `product` has sixteen incoming edges (`INCOMING_EDGES.product` in
 * `entity-incoming-edges.ts`). Their *stable roles* now live in
 * `ENTITY_EDGE_SEMANTICS.product` (`~/server/db/entity-edge-semantics`)
 * alongside every other entity's, because a role describes what an edge means
 * and not what deleting does about it. Three are **acquisition** evidence —
 * proof the thing was actually owned at some point — two are durable
 * **history**, one is a retained Wishlist **association**, two are a
 * **reference** from another row's own record, one is **usage** by a live kit,
 * one is **composition** (a kit's own component list), three are **metadata**,
 * and one is **media**:
 *
 *  - acquisition: `InventoryEntry.productId` (it's on a shelf right now),
 *    `Expense.productId` (it was bought — the ledger's net cost and
 *    owned/sold window derive from this row, so an orphaned product would
 *    silently corrupt that derivation with no restore path), and
 *    `PurchaseProduct.productId` (the vendor order it was bought on —
 *    provenance an allocation-basis Expense can never carry).
 *  - history: `Task.subjectProductId` (work performed on the product; deleting
 *    the subject would leave that durable task history nameless) and
 *    `ProjectToolUsage.productId` (a reusable tool's project-use history).
 *  - association: `WishCandidate.productId` (a candidate alternative remains
 *    meaningful until removed from its Wishlist entries).
 *  - reference: `Location.productId` (a Location that IS this product — the
 *    bin itself) and `Cookbook.productId` (a Cookbook whose physical copy
 *    this product is — the book on the shelf behind the imported EPUB).
 *    Retaining because each linked row deliberately carries no identity of
 *    its own beyond the Product it points at: a Location's `type` and a
 *    Cookbook's shelf link both live only on this side of the edge, so
 *    orphaning the Product would leave the other row with no identity at
 *    all, not merely a broken link.
 *  - usage: `ProductComponent.componentProductId` — this product is cited as
 *    a part inside another (kit) product's component list. Retaining for the
 *    same reason as a purchase link: deleting it would silently shrink the
 *    kit's contents with no record of what used to be there.
 *  - composition: `ProductComponent.parentProductId` — this product's OWN
 *    component list, when it's a kit. NOT retaining, deliberately asymmetric
 *    with the edge above: deleting a kit is supposed to take its component
 *    list with it, the same way deleting a recipe takes its sections.
 *  - metadata / media: `ProductExternalId.productId`,
 *    `ProductUnitMappings.productId`, `ProductConversionCoverage.productId`,
 *    `ProductImage.productId` — none of which say anything about ownership on
 *    their own.
 *
 * ## Why the retaining filter is positive, not `!== "metadata"`
 *
 * Both consumers below used to select blocking edges by *excluding* the
 * metadata role. That was safe only while `metadata` was the sole non-retaining
 * role. Moving `ProductImage.productId` to the shared `media` role would, under
 * a negative filter, have silently promoted a photo attachment into a delete
 * blocker — every product with an image becomes undeletable, and
 * `findOrphanedProducts` stops reporting them. {@link RETAINING_ROLES} makes
 * the set an allowlist instead, so a future role added to the shared vocabulary
 * defaults to *not* retaining and can't quietly change delete behavior.
 *
 * ## Two consumers, two SQL shapes, one declaration
 *
 *  - `findOrphanedProducts` (repo/problems/detectors-product.ts) — a
 *    correlated `notExists` per retaining edge, feeding the Problems page's
 *    one-click delete.
 *  - `deleteProducts` (repo/product/crud.ts) — an `inArray` fetch +
 *    `assertNoDependents` per retaining edge, actually blocking the delete.
 *
 * Both key their own `Record<ProductRetainingEdgeKey, ...>` off the type below,
 * so adding or dropping an acquisition/history edge is a compile error at BOTH
 * call sites until they're updated to match — the guarantee the old prose
 * comment could only ask a reviewer to enforce by hand.
 *
 * **Residual weakness** (the same one `image.ts`'s `IMAGE_HARD_DELETE`
 * carries): declaring a retaining edge only forces each consumer to have *an
 * entry* for it — nothing stops that entry from being wired to the wrong
 * column, or otherwise written incorrectly. Completeness of the *edge set* is
 * compile-time guaranteed; correctness of each edge's SQL is not. The
 * `PRODUCT_EDGE_ROLES backstop` describe block in `product.integration.test.ts`
 * is the cheap regression test that buys back some of that: it exercises every
 * retaining edge (must block delete) and every non-retaining edge (must
 * cascade-soft-delete on a successful delete) against a real product, so a
 * wrong-column or silently-dropped predicate fails a test instead of shipping.
 */

import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { AppErrorReason } from "@cubby/shared";

import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";

export const PRODUCT_EDGE_ROLES = ENTITY_EDGE_SEMANTICS.product;

const RETAINING_ROLES = [
  "acquisition",
  "history",
  "association",
  "reference",
  "usage",
] as const;
type RetainingRole = (typeof RETAINING_ROLES)[number];

/**
 * The subset of `product`'s incoming edges whose role retains the product.
 * Derived from {@link PRODUCT_EDGE_ROLES}, not hand-listed, so it can't drift
 * from it. Both `findOrphanedProducts` and `deleteProducts` key their own
 * per-edge SQL map off this type.
 */
export type ProductRetainingEdgeKey = {
  [
    K in keyof typeof PRODUCT_EDGE_ROLES
  ]: (typeof PRODUCT_EDGE_ROLES)[K]["role"] extends RetainingRole ? K : never;
}[keyof typeof PRODUCT_EDGE_ROLES];

const isProductEdgeKey = (
  key: string,
): key is keyof typeof PRODUCT_EDGE_ROLES =>
  Object.hasOwn(PRODUCT_EDGE_ROLES, key);

export const isRetainingEdgeKey = (
  key: string,
): key is ProductRetainingEdgeKey =>
  isProductEdgeKey(key) &&
  RETAINING_ROLES.some((role) => role === PRODUCT_EDGE_ROLES[key].role);

export type ProductDeleteDisposition =
  | (OperationDisposition & {
      effect: "block";
      reason: AppErrorReason;
      /** Plural noun phrase naming the dependent rows, for the error message
       *  (e.g. "inventory entries", "expenses"). */
      label: string;
    })
  | (OperationDisposition & { effect: "soft-delete" | "hard-delete" })
  // `Device.productId` is the first product-retaining edge that clears
  // rather than blocks or cascades: a device survives its hardware Product's
  // deletion as a device with no linked hardware. Deliberately narrow (only
  // this effect, not a general escape hatch) — see the `Cookbook.productId`
  // comment below for why every other optional back-reference still blocks.
  | (OperationDisposition & { effect: "detach" });

export const PRODUCT_DELETE_EDGE_POLICY = {
  "ImportRunTarget.productId": {
    code: "block-targeted-import-history",
    effect: "block",
    description:
      "A Product retained by targeted validation or enrichment history cannot be deleted.",
    reason: "CONSTRAINT_VIOLATION",
    label: "targeted import runs",
  },
  "InventoryEntry.productId": {
    code: "block-live-inventory",
    effect: "block",
    description:
      "A product still on a shelf can't be deleted — empty the inventory first.",
    reason: "PRODUCT_HAS_INVENTORY",
    label: "inventory entries",
  },
  "Expense.productId": {
    code: "block-live-expense",
    effect: "block",
    description:
      "A product with ledger spend can't be deleted — net cost and the owned/sold window derive from those rows.",
    reason: "PRODUCT_HAS_EXPENSES",
    label: "expenses",
  },
  "Task.subjectProductId": {
    code: "block-live-task-subject",
    effect: "block",
    description:
      "A product that is the subject of work history can't be deleted — the task would be left nameless.",
    reason: "PRODUCT_HAS_TASKS",
    label: "tasks referencing them",
  },
  "ProjectToolUsage.productId": {
    code: "block-live-project-use",
    effect: "block",
    description:
      "A reusable resource with project-use history can't be deleted — detach that history first.",
    reason: "PRODUCT_HAS_PROJECT_USES",
    label: "project uses",
  },
  "PurchaseProduct.productId": {
    code: "block-live-purchase-link",
    effect: "block",
    description:
      "A product recorded against the order that bought it can't be deleted — that link is often the only path back to the purchase, since an installment order's expenses can't carry a product.",
    reason: "PRODUCT_HAS_PURCHASE_LINKS",
    label: "purchase links",
  },
  "MealFoodEntry.productId": {
    code: "block-live-meal-food-entry",
    effect: "block",
    description:
      "A product used by a live meal food entry can't be deleted because the recorded grams depend on that product's nutrition source.",
    reason: "CONSTRAINT_VIOLATION",
    label: "meal food entries",
  },
  "WishCandidate.productId": {
    code: "block-live-wishlist-candidate",
    effect: "block",
    description:
      "A product on the Wishlist remains a live alternative until it is removed from every Wish.",
    reason: "PRODUCT_HAS_WISH_CANDIDATES",
    label: "wishlist candidates",
  },
  "ProductExternalId.productId": {
    code: "soft-delete-metadata",
    effect: "soft-delete",
    description: "External ids (e.g. ASINs) are soft-deleted with the product.",
  },
  "ProductUnitMappings.productId": {
    code: "soft-delete-metadata",
    effect: "soft-delete",
    description:
      "Hand-entered unit conversions are soft-deleted with the product.",
  },
  "Location.productId": {
    code: "block-live-location-identity",
    effect: "block",
    description:
      "A product that a location IS can't be deleted — a linked location carries no `type` of its own, so orphaning it would leave it with no identity at all.",
    reason: "PRODUCT_HAS_LOCATIONS",
    label: "locations",
  },
  "Cookbook.productId": {
    code: "block-live-cookbook-copy",
    effect: "block",
    description:
      "A product that is a cookbook's physical copy can't be deleted — unlink the cookbook first. Blocking rather than clearing the link because the policy vocabulary has no set-null effect, and a soft-delete here would take the cookbook and every recipe it imported with it.",
    reason: "PRODUCT_HAS_COOKBOOKS",
    label: "cookbooks",
  },
  "EntityAttachment.subjectEntityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the product, and each file is\n      deleted too unless something else still references it.",
  },
  "ProductComponent.parentProductId": {
    code: "soft-delete-kit-components",
    effect: "soft-delete",
    description:
      "Deleting a kit takes its own component list with it — the individual component Products are untouched.",
  },
  "ProductComponent.componentProductId": {
    code: "block-live-kit-membership",
    effect: "block",
    description:
      "A product still listed inside a live kit's component list can't be deleted — remove it from the kit first.",
    reason: "PRODUCT_HAS_KIT_LINKS",
    label: "kits it's listed inside",
  },
  "ProductConversionCoverage.productId": {
    code: "hard-delete-conversion-projection",
    effect: "hard-delete",
    description:
      "The rebuildable conversion coverage projection is deleted with the product.",
  },
  "ProductMatchCandidate.productAId": {
    code: "hard-delete-match-review",
    effect: "hard-delete",
    description:
      "Match-queue reviews naming the product are discarded with it.",
  },
  "ProductMatchCandidate.productBId": {
    code: "hard-delete-match-review",
    effect: "hard-delete",
    description:
      "Match-queue reviews naming the product are discarded with it.",
  },
  "Planting.sourceProductId": {
    code: "block-garden-source",
    effect: "block",
    description: "A planting retains its source product for growing history.",
    reason: "CONSTRAINT_VIOLATION",
    label: "garden plantings",
  },
  "Device.productId": {
    code: "clear-hardware",
    effect: "detach",
    description:
      "Deleting a product clears any device's hardware link rather than blocking the delete — a device survives as one with no linked hardware.",
  },
  "PhotoGroupProposal.productId": {
    code: "clear-proposal-product",
    effect: "detach",
    description:
      "Deleting a product clears a photo group proposal's product choice; a proposed group must then pick another Product before approval.",
  },
} as const satisfies IncomingEdgePolicy<"product", ProductDeleteDisposition>;
