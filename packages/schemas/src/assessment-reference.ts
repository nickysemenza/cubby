import { z } from "zod";

/** Assessment/Feedback child handles retain PostgreSQL GUIDs, including historical hash-derived IDs. */
export const assessmentChildHandle = z.guid();

/** Unknown membership is a coverage gap, never a precise count of missing results. */
export const assessmentReadCoverage = z.object({
  missing: z.boolean(),
  stale: z.boolean(),
  unresolved: z.boolean(),
  failed: z.boolean(),
});
export type AssessmentReadCoverage = z.infer<typeof assessmentReadCoverage>;

export const assessmentSuppression = z.object({
  scope: z.string(),
  candidateKey: z.string(),
  fingerprint: z.string().nullable(),
});
export const assessmentReviewReference = z.object({
  assessmentId: assessmentChildHandle,
  suppression: assessmentSuppression,
});
