import { z } from "zod";
import { entityRefSchema } from "./entity-core";

export const fieldExplanationSource = z.object({
  label: z.string(),
  /** Declared source fields whose own values and controls explain this observation. */
  fields: z.array(z.string()).optional(),
  entity: entityRefSchema.nullable(),
  value: z.json(),
});

export const fieldDecisionReason = z.enum([
  "assigned",
  "not_set",
  "explicit",
  "household",
  "inherit",
  "acquisition_absent",
  "acquisition_multiple",
  "acquisition_single",
  "beneficiary_absent",
  "beneficiary_unknown",
  "beneficiary_incomplete",
  "beneficiary_split",
  "beneficiary_unresolved",
  "beneficiary_not_individual",
  "beneficiary_conflict",
  "beneficiary_agreement",
  "vendor_absent",
  "vendor_disabled",
  "vendor_unusable",
  "vendor_enabled",
  "payment_absent",
  "payment_disabled",
  "payment_unresolved",
  "payment_not_individual",
  "payment_conflict",
  "payment_agreement",
]);

export const fieldEvidenceCoverage = z.object({
  total: z.number().int().nonnegative(),
  shown: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
});

/** Observations describe decision inputs; callers identify live or published evidence. */
export const fieldDecisionStep = z.object({
  source: z.string(),
  reason: fieldDecisionReason,
  effect: z.enum(["used", "blocked", "fallback", "overridden", "context"]),
  observed: z.array(fieldExplanationSource),
  /** The matching row in chain.rows, including any branch summary rows. */
  rowIndex: z.number().int().nonnegative(),
  branch: entityRefSchema.optional(),
  coverage: fieldEvidenceCoverage.optional(),
});
export type FieldDecisionStep = z.infer<typeof fieldDecisionStep>;
