import { z } from "zod";
import { plainDate } from "./base-entity";
import { productShortcode, purchaseShortcode } from "./identifiers";

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
  attachedAt: z.date(),
});
export type ProductComponentOut = z.infer<typeof productComponentOut>;
export const productComponentsOut = z.array(productComponentOut);

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
