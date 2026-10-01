import { z } from "zod";

import {
  expenseShortcode,
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
      input.action === "expenses" &&
      new Set(input.expenseIds).size !== input.expenseIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expenseIds"],
        message: "Select each Expense only once.",
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
