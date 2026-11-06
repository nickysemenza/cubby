import { z } from "zod";

/** Suggestion and decision handles retain PostgreSQL GUIDs, including historical hash-derived IDs. */
export const suggestionChildHandle = z.guid();

/** Unknown membership is a coverage gap, never a precise count of missing results. */

export const suggestionSuppression = z.object({
  scope: z.string(),
  candidateKey: z.string(),
  fingerprint: z.string().nullable(),
});
export const suggestionReviewReference = z.object({
  suggestionId: suggestionChildHandle,
  suppression: suggestionSuppression,
});
