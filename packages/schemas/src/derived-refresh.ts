import { z } from "zod";

export const derivedRefreshReceipt = z.object({
  mode: z.literal("background"),
});

export const embeddingArtifactState = z.enum([
  "legacy",
  "prepared",
  "submitting",
  "submitted",
  "selected",
  "retired",
  "failed",
]);
