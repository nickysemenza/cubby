import { z } from "zod";

export const sourceOccurrenceIdentityKind = z.enum(["provider", "positioned"]);
export const sourceOccurrenceReviewState = z.enum([
  "ready",
  "identity_conflict",
  "judgment_conflict",
  "ownership_conflict",
  "revision_order_unknown",
  "reappeared",
]);
