import {
  productCategorySummary,
  rawProductCategorySummary,
} from "./product-category-fields";
import { z } from "zod";
import { productShortcode } from "./identifier-fields";
import { moneyNullable, positiveMoneyNullable } from "./money";

/** A USDA food link is a positive fdc_id, shared by identity and cache policy. */
export const hasFdcLink = (fdc_id: number | null | undefined): boolean =>
  fdc_id != null && fdc_id > 0;

/** Cycle-safe Product field schemas used by generated contracts. */
export const productCategory = productCategorySummary;
export const rawProductCategory = rawProductCategorySummary;

/** Product identity in linked-record and recommendation responses. */
export const productRefOut = z.object({
  id: productShortcode,
  name: z.string(),
});

/** Thin Product identity with a thumbnail for cookbook and import review. */
export const productSummaryWithCover = productRefOut.extend({
  coverUrl: z.string().nullable(),
});

/** Descriptive Cost is separate from the editable numeric valuation price. */
export const productCost = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), amount: z.number() }),
  z.object({
    kind: z.literal("service_charge"),
    amount: z.number(),
    chargeCount: z.number().int().positive(),
    latestCharge: moneyNullable,
    /** Absent on retained publications until their evidence is backfilled. */
    chargeTotal: z.number().optional(),
  }),
]);

export const productPricingOut = z.object({
  cost: z
    .object({
      amount: moneyNullable,
      label: z.string().nullable(),
      explanation: z.string(),
      chargeCount: z.number().int().nonnegative(),
      latestCharge: moneyNullable,
    })
    .nullish(),
  derivedPrice: moneyNullable,
  effectivePrice: moneyNullable,
  source: z.enum(["explicit", "derived", "none"]),
  knownExpenseCount: z.number().int().nonnegative(),
  unknownExpenseCount: z.number().int().nonnegative(),
  // Sum of acquisition quantities, which are fractional for by-weight lines.
  knownUnitCount: z.number().nonnegative(),
  partial: z.boolean(),
});

/** Coverage evidence does not publish a second price or Cost result. */
export const productPricingEvidence = productPricingOut.pick({
  knownExpenseCount: true,
  unknownExpenseCount: true,
  knownUnitCount: true,
  partial: true,
});

export { moneyNullable, positiveMoneyNullable };

/**
 * Whether a Product is used up (`consumable`) or kept and reused (`durable`).
 * Independent of `stockTracked`, the choice to count stock. Unset means
 * undecided; nothing penalizes it and it never rewrites existing Expenses —
 * it only informs project suggestions and worklist filters. Adding a value
 * widens the generated CHECK: ship the migration before the code.
 */
/** Shelf against ledger where both are comparable (product `quantityVarianceState`). */
export const productQuantityVarianceState = z.enum(["matched", "mismatched"]);
export const productKindValues = ["consumable", "durable"] as const;
export const productKindSchema = z.enum(productKindValues);
export type ProductKind = z.infer<typeof productKindSchema>;

export const PRODUCT_KIND_LABELS = {
  consumable: "Consumable",
  durable: "Durable",
} as const satisfies Record<ProductKind, string>;
