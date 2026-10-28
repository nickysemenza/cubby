import { z } from "zod";
import {
  fieldDecisionStep,
  fieldExplanationSource,
  fieldEvidenceCoverage,
} from "./field-explanation-evidence";
export {
  fieldDecisionStep,
  fieldExplanationSource,
  fieldDecisionReason,
  fieldEvidenceCoverage,
  type FieldDecisionStep,
} from "./field-explanation-evidence";
import { fieldEnvelope, fieldResult } from "./field-envelope";
import { dataExceptionReason, dataQualityStatus } from "./data-quality-shape";
import { entityRefSchema } from "./entity-core";
import { reportRecordsBlock } from "./entity-report";
import { fieldResolutionSourceSchema } from "./field-resolution";

/** Comparison data only: its JSON is never trusted as provenance or entity references. */
const displayedFieldResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("live"), decision: z.json() }),
  z.object({
    kind: z.literal("cached"),
    computedAt: z.iso.datetime(),
    decision: z.json(),
  }),
]);

export const fieldExplanationInput = entityRefSchema.extend({
  field: z.string().min(1),
  /** The result visible on the requesting surface, including its publication revision. */
  displayedResult: displayedFieldResult.optional(),
  /** Live recomputation is an explicit diagnostic, never part of opening an explanation. */
  diagnostic: z.boolean().optional(),
  /** The singular list scope whose contextual value is being explained. */
  scope: entityRefSchema.optional(),
  surface: z.enum(["list", "detail", "summary"]).default("detail"),
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
  publication: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("current") }),
      z.object({ kind: z.literal("superseded"), reason: z.string() }),
      z.object({ kind: z.literal("unavailable"), reason: z.string() }),
    ])
    .optional(),
  interpretation: z
    .object({
      result: z.string(),
      summary: z.string(),
      caveats: z.array(z.string()),
      nextSteps: z.array(z.string()),
    })
    .optional(),
  qualityBreakdown: qualityBreakdown.optional(),
  /** Current member decisions and available controls, separate from published score evidence. */
  currentQualityControls: qualityBreakdown.shape.checks.optional(),
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
