import { z } from "zod";
import { dataExceptionReason } from "./data-quality-shape";
import { entityRefSchema } from "./entity";
import {
  fieldResolutionSchema,
  fieldResolutionSourceSchema,
} from "./field-resolution";

export const fieldExplanationInput = entityRefSchema.extend({
  field: z.string().min(1),
  surface: z.enum(["list", "detail", "summary"]).default("detail"),
});

export const fieldExplanationSource = z.object({
  label: z.string(),
  entity: entityRefSchema.nullable(),
  value: z.json(),
});

export const qualityBreakdown = z.object({
  score: z.number(),
  expectedWeight: z.number(),
  satisfiedWeight: z.number(),
  checks: z.array(
    z.object({
      check: z.string(),
      label: z.string(),
      facet: z.string(),
      kind: z.enum(["missing", "defect"]),
      weight: z.number(),
      state: z.enum(["satisfied", "gap", "excepted"]),
      description: z.string(),
      /**
       * Reasons the server accepts for `dataQuality.setException` on this
       * check; empty when the check forbids exceptions, so no client restates
       * the list.
       */
      exceptionReasons: z.array(
        z.object({ reason: dataExceptionReason, label: z.string() }),
      ),
      /** The recorded exception, active or stale, that `clearException` removes. */
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

export const fieldExplanationOutput = z.object({
  subject: entityRefSchema,
  field: z.string(),
  label: z.string(),
  value: z.json(),
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
  rule: z.object({
    id: z.string(),
    revision: z.number().int(),
    description: z.string(),
  }),
  sources: z.array(fieldExplanationSource),
  resolution: fieldResolutionSchema.nullable(),
  resolutionEvidence: z
    .object({
      hierarchy: z.array(fieldExplanationSource).max(50),
      fallbackSource: fieldResolutionSourceSchema.nullable(),
    })
    .nullable()
    .optional(),
  truncated: z.boolean(),
  evidenceFingerprint: z.string().nullable(),
  actions: z.array(
    z.object({
      kind: z.enum(["confirmOwner", "inheritOwner", "editSource"]),
      label: z.string(),
      target: entityRefSchema,
    }),
  ),
});

export type FieldExplanationOutput = z.infer<typeof fieldExplanationOutput>;
