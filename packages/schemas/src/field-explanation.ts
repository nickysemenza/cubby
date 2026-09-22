import { z } from "zod";
import { entityRefSchema } from "./entity";
import { fieldResolutionSchema } from "./field-resolution";

export const fieldExplanationInput = entityRefSchema.extend({
  field: z.string().min(1),
  surface: z.enum(["list", "detail", "summary"]).default("detail"),
});

export const fieldExplanationSource = z.object({
  label: z.string(),
  entity: entityRefSchema.nullable(),
  value: z.json(),
});

export const fieldExplanationOutput = z.object({
  subject: entityRefSchema,
  field: z.string(),
  label: z.string(),
  value: z.json(),
  evaluatedAt: z.iso.datetime(),
  rule: z.object({
    id: z.string(),
    revision: z.number().int(),
    description: z.string(),
  }),
  sources: z.array(fieldExplanationSource),
  resolution: fieldResolutionSchema.nullable(),
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
