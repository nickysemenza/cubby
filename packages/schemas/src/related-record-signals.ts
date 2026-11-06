import { z } from "zod";

/** Static same-entity discovery policy. Scalar overlaps are supporting evidence. */
export const relatedRecordSignalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("semantic"),
      label: z.string().min(1),
      weight: z.number().positive(),
      limit: z.number().int().min(1).max(25),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scalarOverlap"),
      label: z.string().min(1),
      field: z.string().min(1),
      popularityCap: z.number().int().positive(),
      scoring: z.literal("displayOnly"),
    })
    .strict(),
]);
export type RelatedRecordSignal = z.infer<typeof relatedRecordSignalSchema>;
