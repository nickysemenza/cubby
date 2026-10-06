import { z } from "zod";

/**
 * What a classification says about one field of the record it classifies:
 * `required` makes a missing value a data-quality gap, `not_expected` and
 * `unknown` raise no gap, and `not_allowed` is `not_expected` plus a refusal —
 * the record may not carry a value at all. One vocabulary for manifest-declared
 * policies (`capabilities.classificationPolicies`) and per-row policy columns
 * (SpendingCategory `productExpectation`); see
 * `classification-field-policy.ts`.
 */
export const fieldPolicyValues = [
  "unknown",
  "required",
  "not_expected",
  "not_allowed",
] as const;
export const fieldPolicyValue = z.enum(fieldPolicyValues);
export type FieldPolicyValue = z.infer<typeof fieldPolicyValue>;
