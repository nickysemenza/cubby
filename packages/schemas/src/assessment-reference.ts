import { z } from "zod";

/** Assessment/Feedback child handles retain PostgreSQL GUIDs, including historical hash-derived IDs. */
export const assessmentChildHandle = z.guid();

export const assessmentSuppression = z.object({
  scope: z.string(),
  candidateKey: z.string(),
  fingerprint: z.string().nullable(),
});
export const assessmentReviewReference = z.object({
  assessmentId: assessmentChildHandle,
  suppression: assessmentSuppression,
});
