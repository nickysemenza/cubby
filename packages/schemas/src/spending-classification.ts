import { z } from "zod";

import { spendingCategoryShortcode } from "./identifier-fields";

export const spendingCategoryMappingModeValues = [
  "inherit",
  "mapped",
  "blocked",
] as const;
export const spendingCategoryMappingMode = z.enum(
  spendingCategoryMappingModeValues,
);
export const vendorSpendingProfileValues = [
  "unspecified",
  "mixed_retail",
  "food_retail",
  "restaurant",
  "coffee_shop",
] as const;
export const vendorSpendingProfile = z.enum(vendorSpendingProfileValues);

export const spendingCategoryAllocationSchema = z.object({
  spendingCategoryId: spendingCategoryShortcode.nullable(),
  spendingCategoryName: z.string().nullable(),
  amount: z.number().nullable(),
  basis: z.enum(["principal", "positive", "refund", "default"]),
  incomplete: z.boolean(),
});
export const spendingCategoryAllocationsSchema = z.array(
  spendingCategoryAllocationSchema,
);
export const spendingCategorySummarySchema = z.object({
  state: z.enum([
    "single",
    "mixed",
    "partial",
    "unclassified",
    "not_applicable",
  ]),
  categories: z.array(
    z.object({
      id: spendingCategoryShortcode,
      name: z.string(),
      amount: z.number().nullable(),
    }),
  ),
  lineCount: z.number().int().nonnegative(),
  categorizedLineCount: z.number().int().nonnegative(),
  uncategorizedLineCount: z.number().int().nonnegative(),
  complete: z.boolean(),
  amountsKnown: z.boolean(),
});
export type SpendingCategorySummary = z.infer<
  typeof spendingCategorySummarySchema
>;
export type SpendingCategoryAllocation = z.infer<
  typeof spendingCategoryAllocationSchema
>;

export type SpendingCategoryMappingMode = z.infer<
  typeof spendingCategoryMappingMode
>;
export type VendorSpendingProfile = z.infer<typeof vendorSpendingProfile>;
