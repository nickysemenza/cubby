import {
  cookbookLlmUsageSchema,
  importRecipeSchema,
  importRecipesSchema,
} from "@cubby/schemas/import-recipe";
import { z } from "zod";

const count = z.number().int().nonnegative();
const tier = z.enum(["primary", "fallback"]);
const failedAttempt = z.object({
  attempt: count,
  message: z.string(),
  usage: cookbookLlmUsageSchema,
  truncated: z.boolean(),
});
const tierFailure = z.object({
  message: z.string(),
  usage: cookbookLlmUsageSchema,
  truncated: z.boolean(),
  attempts: z.array(failedAttempt),
});
const chunkFailure = z.object({
  index: count,
  doc_path: z.string(),
  primary: tierFailure,
  fallback: tierFailure.optional(),
});

// Upstream's raw chunk recipes flatten their metadata; assembled recipes nest it.
const extractedRecipe = importRecipeSchema.shape.meta.extend({
  sections: importRecipeSchema.shape.sections,
});

export const extractionProgressSchema = z.object({
  done: count,
  total: count,
  cached: count,
  failed: count,
  preview: importRecipesSchema.optional(),
});

export const extractionReportSchema = z.object({
  recipes: importRecipesSchema,
  chunks: z.array(
    z.object({
      index: count,
      doc_path: z.string(),
      tier,
      recipes: z.array(extractedRecipe),
      usage: cookbookLlmUsageSchema,
      tier_usage: cookbookLlmUsageSchema,
      cached: z.boolean(),
      truncated: z.boolean(),
      primary_failure: tierFailure.optional(),
    }),
  ),
  failures: z.array(chunkFailure),
  usage: cookbookLlmUsageSchema,
  primary_usage: cookbookLlmUsageSchema,
  fallback_usage: cookbookLlmUsageSchema,
  chunks_cached: count,
  truncations: z.array(z.object({ index: count, doc_path: z.string(), tier })),
});

export type ExtractionReport = z.output<typeof extractionReportSchema>;
export type FailedChunk = z.output<typeof chunkFailure>;

export function failureMessage(chunk: FailedChunk): string {
  return chunk.fallback
    ? `Primary: ${chunk.primary.message}; fallback: ${chunk.fallback.message}`
    : chunk.primary.message;
}
