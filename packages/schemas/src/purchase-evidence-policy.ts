import { z } from "zod";

import { fieldPolicyValues } from "./field-policy-fields";

export const itemizationExpectationValues = [
  "unknown",
  "required",
  "not_expected",
] as const;
export const itemizationExpectation = z.enum(itemizationExpectationValues);
export type ItemizationExpectation = z.infer<typeof itemizationExpectation>;
/**
 * A SpendingCategory's Product expectation. `not_allowed` is stronger than
 * `not_expected`: an Expense in the category neither expects nor may link a
 * Product (a restaurant meal). `not_expected` only stops the missing-Product
 * gap (groceries still link Products). Coverage stays three-valued. This is
 * the per-row column instance of the field-policy vocabulary, registered as
 * `spendingCategory.productExpectation` in `classification-field-policy.ts`.
 */
export const productExpectationValues = fieldPolicyValues;
export const productExpectation = z.enum(productExpectationValues);
export type ProductExpectation = z.infer<typeof productExpectation>;

/** Completeness of evidence or Product links, including partial coverage of an owner. */
export const coverageStatus = z.enum([
  "missing",
  "partial",
  "present",
  "not_expected",
  "unknown",
]);
/** One Purchase's document and itemization evidence cannot be partially present. */
export const evidenceCoverageStatus = coverageStatus.exclude(["partial"]);

export const purchaseEvidenceCoverage = z.object({
  expectation: itemizationExpectation,
  booking: z.enum(["missing", "partial", "recorded"]),
  document: evidenceCoverageStatus,
  itemization: evidenceCoverageStatus,
  products: coverageStatus,
});
export type PurchaseEvidenceCoverage = z.infer<typeof purchaseEvidenceCoverage>;

export const financialTransactionCoverage = z.object({
  expectation: itemizationExpectation,
  booking: z.enum([
    "missing",
    "partial",
    "recorded",
    "not_applicable",
    "unclassified",
  ]),
  document: coverageStatus,
  itemization: coverageStatus,
  products: coverageStatus,
});
export type FinancialTransactionCoverage = z.infer<
  typeof financialTransactionCoverage
>;
