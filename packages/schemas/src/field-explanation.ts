import { z } from "zod";
import { fieldEnvelope, fieldResult } from "./field-envelope";
import { dataExceptionReason, dataQualityStatus } from "./data-quality-shape";
import { entityRefSchema } from "./entity";
import { reportRecordsBlock } from "./entity-report";
import { fieldResolutionSourceSchema } from "./field-resolution";

export const fieldExplanationInput = entityRefSchema.extend({
  field: z.string().min(1),
  /** The singular list scope whose contextual value is being explained. */
  scope: entityRefSchema.optional(),
  surface: z.enum(["list", "detail", "summary"]).default("detail"),
});

export const fieldExplanationSource = z.object({
  label: z.string(),
  /** Declared source fields whose own values and controls explain this observation. */
  fields: z.array(z.string()).optional(),
  entity: entityRefSchema.nullable(),
  value: z.json(),
});

export const qualityBreakdown = z.object({
  /** Null when not assessed; otherwise the weighted score after caps. */
  score: z.number().nullable(),
  status: dataQualityStatus,
  /** The uncapped weighted score; null when no weighted check applies. */
  weightedScore: z.number().nullable(),
  /** The lowest cap an unresolved check imposes; null when none is unresolved. */
  scoreCap: z.number().nullable(),
  expectedWeight: z.number(),
  satisfiedWeight: z.number(),
  /** The score arithmetic as display text; clients render it verbatim. */
  summary: z.string(),
  checks: z.array(
    z.object({
      check: z.string(),
      label: z.string(),
      facet: z.string(),
      kind: z.enum(["missing", "defect"]),
      weight: z.number(),
      /** The highest score this record may show while the check is a gap. */
      scoreCap: z.number(),
      state: z.enum(["satisfied", "gap", "excepted"]),
      /** Display text for `state` (and `kind` when a gap): "Defect", "Missing data", … */
      stateLabel: z.string(),
      /**
       * Display text for `weight` (and a declared cap): "weight 3",
       * "Unscored diagnostic", "weight 3 · caps at 60 while unresolved".
       */
      weightLabel: z.string(),
      description: z.string(),
      /**
       * Reasons the server accepts for `dataQuality.setException` on this
       * check; empty when the check forbids exceptions, so no client restates
       * the list.
       */
      exceptionReasons: z.array(
        z.object({ reason: dataExceptionReason, label: z.string() }),
      ),
      /**
       * The recorded exception that `clearException` removes. Waivers never
       * reopen; `stale` marks only a recorded waiver on a check that no longer
       * accepts waivers.
       */
      exception: z
        .object({
          reason: dataExceptionReason,
          note: z.string(),
          state: z.enum(["active", "stale"]),
        })
        .optional(),
    }),
  ),
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

/** Observations are current inputs, never a claim about historical intent. */
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

/** A computed empty result is distinct from a comparison that cannot be run. */
export const fieldLiveComparison = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    result: fieldResult(z.json()).options[1],
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

/** A display image's precedence chain: one level per source, in order. */
export const imageChainExplanation = z.object({
  levels: z.array(
    z.object({
      label: z.string(),
      source: entityRefSchema.nullable(),
      images: z.array(
        z.object({ id: z.string(), url: z.string(), chosen: z.boolean() }),
      ),
    }),
  ),
});

export const fieldExplanationOutput = z.object({
  subject: entityRefSchema,
  field: z.string(),
  label: z.string(),
  envelope: fieldEnvelope(z.json(), z.json()),
  evaluatedAt: z.iso.datetime(),
  interpretation: z
    .object({
      result: z.string(),
      summary: z.string(),
      caveats: z.array(z.string()),
      nextSteps: z.array(z.string()),
    })
    .optional(),
  qualityBreakdown: qualityBreakdown.optional(),
  comparison: fieldLiveComparison,
  imageChain: imageChainExplanation.optional(),
  rule: z.object({
    id: z.string(),
    revision: z.number().int(),
    description: z.string(),
  }),
  sources: z.array(fieldExplanationSource),
  resolutionEvidence: z
    .object({
      /** Evaluated sources in precedence order, with reasons and outcome labels. */
      chain: reportRecordsBlock,
      steps: z.array(fieldDecisionStep).optional(),
      coverage: fieldEvidenceCoverage.optional(),
      /** Coverage of inventory branches, independently of their decision rows. */
      branches: fieldEvidenceCoverage.optional(),
      fallbackSource: fieldResolutionSourceSchema.nullable(),
      /** Null effective values can mean different things; the server owns that distinction. */
      outcome: z.enum(["resolved", "mixed", "unset", "blocked"]).optional(),
      /** Independent contributors, each with its own precedence chain. */
      contributors: z
        .array(
          z.object({
            chain: reportRecordsBlock,
            steps: z.array(fieldDecisionStep).optional(),
            coverage: fieldEvidenceCoverage.optional(),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
  truncated: z.boolean(),
  actions: z.array(
    z.object({
      kind: z.enum(["editSource"]),
      label: z.string(),
      target: entityRefSchema,
    }),
  ),
});

export type FieldExplanationOutput = z.infer<typeof fieldExplanationOutput>;
