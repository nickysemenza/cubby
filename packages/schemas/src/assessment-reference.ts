import { z } from "zod";

/** Assessment/Feedback child handles retain PostgreSQL GUIDs, including historical hash-derived IDs. */
export const assessmentChildHandle = z.guid();

/** Unknown membership is a coverage gap, never a precise count of missing results. */

export const assessmentSuppression = z.object({
  scope: z.string(),
  candidateKey: z.string(),
  fingerprint: z.string().nullable(),
});
export const assessmentReviewReference = z.object({
  assessmentId: assessmentChildHandle,
  suppression: assessmentSuppression,
});
