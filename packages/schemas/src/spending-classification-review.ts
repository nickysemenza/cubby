import { z } from "zod";

import {
  expenseShortcode,
  productShortcode,
  productCategoryShortcode,
  spendingCategoryShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  spendingCategoryMappingMode,
  vendorSpendingProfile,
} from "./spending-classification";

export const spendingClassificationReviewInput = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("products"),
        productIds: z.array(productShortcode).min(1).max(500),
        productCategoryId: productCategoryShortcode,
      })
      .strict(),
    z
      .object({
        action: z.literal("productCategory"),
        productCategoryId: productCategoryShortcode,
        spendingCategoryMode: spendingCategoryMappingMode,
        spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
      })
      .strict(),
    z
      .object({
        action: z.literal("vendor"),
        vendorId: vendorShortcode,
        spendingProfile: vendorSpendingProfile,
        defaultSpendingCategoryId: spendingCategoryShortcode
          .nullable()
          .default(null),
      })
      .strict(),
    z
      .object({
        action: z.literal("expenses"),
        expenseIds: z.array(expenseShortcode).min(1).max(500),
        spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
      })
      .strict(),
    z
      .object({
        action: z.literal("spendingCategoryMerge"),
        keepId: spendingCategoryShortcode,
        mergeIds: z.array(spendingCategoryShortcode).min(1).max(50),
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (
      input.action === "productCategory" &&
      (input.spendingCategoryMode === "mapped") !==
        (input.spendingCategoryId !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["spendingCategoryId"],
        message:
          "Mapped requires a category; inherit and blocked require no category.",
      });
    }
    if (
      input.action === "products" &&
      new Set(input.productIds).size !== input.productIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["productIds"],
        message: "Select each Product only once.",
      });
    }
    if (
      input.action === "expenses" &&
      new Set(input.expenseIds).size !== input.expenseIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expenseIds"],
        message: "Select each Expense only once.",
      });
    }
    if (
      input.action === "spendingCategoryMerge" &&
      (new Set(input.mergeIds).size !== input.mergeIds.length ||
        input.mergeIds.includes(input.keepId))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mergeIds"],
        message: "Name each merged category once, and never the keeper.",
      });
    }
  });

const integerCents = z.string().regex(/^-?\d+$/u);
export const spendingClassificationReviewPreview = z.object({
  request: spendingClassificationReviewInput,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  policyRevision: z.string(),
  expenseCount: z.number().int().nonnegative(),
  changedExpenseCount: z.number().int().nonnegative(),
  unpricedExpenseCount: z.number().int().nonnegative(),
  beforeUncategorizedExpenseCount: z.number().int().nonnegative(),
  afterUncategorizedExpenseCount: z.number().int().nonnegative(),
  categoryDeltas: z.array(
    z.object({
      spendingCategoryId: spendingCategoryShortcode.nullable(),
      spendingCategoryName: z.string().nullable(),
      beforeCents: integerCents,
      afterCents: integerCents,
      deltaCents: integerCents,
    }),
  ),
});

export const spendingClassificationReviewApplyInput = z
  .object({
    request: spendingClassificationReviewInput,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const spendingClassificationReviewResult = z.object({
  applied: z.literal(true),
  updatedRecords: z.number().int().nonnegative(),
  impact: spendingClassificationReviewPreview,
});

export type SpendingClassificationReviewInput = z.infer<
  typeof spendingClassificationReviewInput
>;
export type SpendingClassificationReviewPreview = z.infer<
  typeof spendingClassificationReviewPreview
>;
export type SpendingClassificationReviewApplyInput = z.infer<
  typeof spendingClassificationReviewApplyInput
>;
