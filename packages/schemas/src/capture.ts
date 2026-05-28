import { z } from "zod";
import { confidence } from "./ai";

/**
 * One item the vision model proposed from a shelf photo. Stateless: the
 * `capture.analyze` query returns these and the client holds them in component
 * state through review — nothing is persisted until an item is approved into
 * inventory. (A persistent "review later" queue is a separate future step.)
 */
export const proposedItemSchema = z.object({
  name: z.string(),
  manufacturer: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
  confidence,
});
export type ProposedItem = z.infer<typeof proposedItemSchema>;

/** Input to analyze an already-uploaded shelf photo. */
export const captureAnalyzeInputSchema = z.object({
  imageId: z.uuid(),
  /** Optional location name to give the vision model context (e.g. "garage"). */
  locationHint: z.string().optional(),
});
export type CaptureAnalyzeInput = z.infer<typeof captureAnalyzeInputSchema>;

/** Result of analyzing a shelf photo. */
export const captureAnalysisSchema = z.object({
  proposedItems: z.array(proposedItemSchema),
  summary: z.string(),
});
export type CaptureAnalysis = z.infer<typeof captureAnalysisSchema>;
