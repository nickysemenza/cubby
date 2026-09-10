import { productCategoryValues } from "@cubby/shared";
import { z } from "zod";
import { moneyNullable, positiveMoneyNullable } from "./money";

/** Cycle-safe Product field schemas used by generated contracts. */
export const productCategory = z
  .enum(productCategoryValues)
  .describe("Product category");

export const productPricingOut = z.object({
  derivedPrice: moneyNullable,
  effectivePrice: moneyNullable,
  source: z.enum(["explicit", "derived", "none"]),
  knownExpenseCount: z.number().int().nonnegative(),
  unknownExpenseCount: z.number().int().nonnegative(),
  knownUnitCount: z.number().int().nonnegative(),
  partial: z.boolean(),
});

export { moneyNullable, positiveMoneyNullable };
