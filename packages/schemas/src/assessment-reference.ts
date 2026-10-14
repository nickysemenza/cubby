import { z } from "zod";

export const assessmentSuppression = z.object({
  scope: z.string(),
  candidateKey: z.string(),
  fingerprint: z.string().nullable(),
});
export const assessmentReviewReference = z.object({
  assessmentId: z.uuid(),
  suppression: assessmentSuppression,
});
