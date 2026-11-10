import { z } from "zod";

import { fieldPolicyValues } from "./field-policy-fields";

const itemizationExpectationValues = [
  "unknown",
  "required",
  "not_expected",
] as const;
export const itemizationExpectation = z.enum(itemizationExpectationValues);
/**
 * A SpendingCategory's Product expectation. `not_allowed` is stronger than
 * `not_expected`: an Expense in the category neither expects nor may link a
 * Product (a restaurant meal). `not_expected` only stops the missing-Product
 * gap (groceries still link Products). Coverage stays three-valued. This is
 * the per-row column instance of the field-policy vocabulary, registered as
 * `spendingCategory.productExpectation` in `classification-field-policy.ts`.
 */
const productExpectationValues = fieldPolicyValues;
export const productExpectation = z.enum(productExpectationValues);

/** Completeness of evidence or Product links, including partial coverage of an owner. */
const coverageStatus = z.enum([
  "missing",
  "partial",
  "present",
  "not_expected",
  "unknown",
]);
/** One Purchase's document and itemization evidence cannot be partially present. */
const evidenceCoverageStatus = coverageStatus.exclude(["partial"]);

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
