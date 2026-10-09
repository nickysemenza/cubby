import { z } from "zod";

export const retainedEvidenceId = z
  .uuid()
  .describe(
    "An evidenceId returned by a retained observation for this workRef. Read the source before citing it. messageRef, browser observationId, attachment references and original IDs are not evidence IDs.",
  );

/** Quoted text is an observation; semantic reasoning binds it to the ordered identity. */
export const researchClaimSupport = z.object({
  observation: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
  selectedVariant: z
    .object({
      identity: z.string().trim().min(1),
      attributes: z.record(z.string().min(1), z.string()),
      reasoning: z.string().trim().min(1),
    })
    .optional(),
});
export type ResearchClaimSupport = z.infer<typeof researchClaimSupport>;

export const acceptedResearchFact = z.object({
  evidenceId: retainedEvidenceId,
  /** Mail facts bind to an original order operand; the host supplies its committed subject. */
  orderIndex: z.number().int().nonnegative().optional(),
  fieldPath: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u),
  value: z.json(),
  support: researchClaimSupport,
});
export type AcceptedResearchFact = z.infer<typeof acceptedResearchFact>;
