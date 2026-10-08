import { z } from "zod";

const acceptedIndices = z.array(z.number().int().min(0).max(99)).max(100);
/** Semantic source support is separate from ownership and replay authority. */
export const researchAssessment = z.object({
  identityVerified: z.boolean(),
  scopeCompletionVerified: z.boolean().default(false),
  acceptedFacts: acceptedIndices,
  acceptedIdentifiers: acceptedIndices,
  acceptedIdentifierClaims: acceptedIndices.default([]),
  acceptedImages: acceptedIndices,
  acceptedOrders: acceptedIndices.default([]),
  acceptedEmailLinks: acceptedIndices.default([]),
  rejected: z
    .array(z.object({ path: z.string().min(1), reason: z.string().min(1) }))
    .max(300),
});
export type ResearchAssessment = z.infer<typeof researchAssessment>;
