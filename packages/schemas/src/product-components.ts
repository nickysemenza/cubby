import { z } from "zod";
import { plainDate } from "./base-entity";
import { productShortcode, purchaseShortcode } from "./identifiers";
import { createItemsResponseSchema } from "./pagination";
import { productListItemOut } from "./product";

/**
 * What's inside a kit (`ProductComponent` in schema.ts). A combo tool kit or a
 * multi-pack is a Product like any other — it keeps its own UPC, model, ASIN,
 * image, and purchase history — but it is ALSO made of other Products, and
 * this is the only place that's recorded. One row per distinct component; a
 * 4-pack of one part is one row with `quantity: 4`, a 9-piece kit is nine
 * rows.
 *
 * Non-entity, same as `PurchaseProduct` (`./purchase`): no shortcode, no
 * entity-manifest entry. Mirrors that module's shapes as closely as the extra
 * `quantity` field allows.
 */

const componentQuantity = z
  .number()
  .int()
  .min(1)
  .max(9999)
  .describe("How many of this component one unit of the kit contains.");

export const productComponentsInput = z.object({
  parentProductId: productShortcode,
});

export const kitMembershipsInput = z.object({
  productId: productShortcode,
});

/**
 * Several kits at once — the Products list expands every kit on the page, so
 * it asks once rather than per expanded row. Bounded well above the 21 kits
 * that exist; the cap is a guard, not a paging scheme.
 */
export const kitComponentRowsInput = z.object({
  parentProductIds: z.array(productShortcode).min(1).max(200),
});

export const productComponentEntryInput = z.object({
  productId: productShortcode,
  quantity: componentQuantity,
});

export const attachProductComponentsInput = z.object({
  parentProductId: productShortcode,
  components: z.array(productComponentEntryInput).min(1).max(100),
});
export type AttachProductComponentsInput = z.infer<
  typeof attachProductComponentsInput
>;

export const detachProductComponentsInput = z.object({
  parentProductId: productShortcode,
  componentProductIds: z.array(productShortcode).min(1).max(100),
});
export type DetachProductComponentsInput = z.infer<
  typeof detachProductComponentsInput
>;

export const productComponentMutationOut = z.object({
  changed: z.number().int().nonnegative(),
  attached: z.number().int().nonnegative(),
});
export type ProductComponentMutationOut = z.infer<
  typeof productComponentMutationOut
>;

/** One row on a kit's own component list. */
export const productComponentOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  quantity: componentQuantity,
  price: z
    .number()
    .nullable()
    .describe("Effective valuation/costing price — display only, not spend."),
  coverImageUrl: z.url().nullable(),
  /**
   * Live units of this component on shelves — how the kit's stock is actually
   * held once it has been split into a composition record. `0` means genuinely
   * unaccounted (no entries, not in service as a Location); `null` means
   * unanswerable, because the component's entries carry incompatible units and
   * summing them would produce a number that means nothing.
   *
   * That `0`/`null` split is deliberately NOT the one `loadProductQuantitySummaries`
   * uses — it collapses both to null because a variance against an unknown shelf
   * is unknown either way. Here the two differ: a part at 0 is the gap this
   * column exists to show.
   */
  onHandUnits: z.number().nullable(),
  attachedAt: z.date(),
});
export type ProductComponentOut = z.infer<typeof productComponentOut>;
export const productComponentsOut = z.array(productComponentOut);

/**
 * The same rows in the `{items}` envelope every MCP list tool returns.
 *
 * A tool whose declared output root is a bare array is unusable over MCP: the
 * SDK re-validates `structuredContent` against an object, so the array root
 * that serves the tRPC callers fine failed EVERY `list_product_components`
 * call. The router keeps returning the array — only the MCP boundary wraps.
 */
export const productComponentsMcpOut =
  createItemsResponseSchema(productComponentOut);

/**
 * A component as a full PRODUCT LIST ROW, for tables that nest a kit's
 * components under it as ordinary rows of their own table.
 *
 * Distinct from `productComponentOut` above on purpose. That one is the
 * detail-page projection — seven fields, all a panel needs. This one embeds
 * the entire list row so a child fills every column its parent fills; anything
 * narrower renders blanks in columns the parent populates, and a blank reads
 * as "zero", not as "not fetched".
 *
 * `parentProductId` is carried because one product can be a component of
 * several kits, so the pair — not the product — identifies the row.
 */
export const kitComponentRowOut = z.object({
  parentProductId: productShortcode,
  quantity: componentQuantity,
  product: productListItemOut,
});
export type KitComponentRowOut = z.infer<typeof kitComponentRowOut>;
export const kitComponentRowsOut = z.array(kitComponentRowOut);

/**
 * The kit's own most recent live purchase — enough to link straight to the
 * order that actually carries the money, since the component itself has none.
 */
export const kitMembershipPurchaseOut = z.object({
  purchaseId: purchaseShortcode,
  displayLabel: z.string().nullable(),
  vendorName: z.string().nullable(),
  date: plainDate,
  orderId: z.string().nullable(),
});
export type KitMembershipPurchaseOut = z.infer<typeof kitMembershipPurchaseOut>;

/** The transpose: one kit a Product is listed inside, most recent first. */
export const kitMembershipOut = z.object({
  parentProductId: productShortcode,
  parentProductName: z.string(),
  manufacturer: z.string(),
  quantity: componentQuantity,
  coverImageUrl: z.url().nullable(),
  attachedAt: z.date(),
  price: z
    .number()
    .nullable()
    .describe(
      "The kit's own effective valuation/costing price — display only, not spend.",
    ),
  expenseCount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Live Expenses recorded on the kit itself — this component carries none of its own.",
    ),
  purchase: kitMembershipPurchaseOut
    .nullable()
    .describe(
      "The kit's most recent purchase, if any — this component was never purchased separately.",
    ),
});
export type KitMembershipOut = z.infer<typeof kitMembershipOut>;
export const kitMembershipsOut = z.array(kitMembershipOut);
