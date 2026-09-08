import type { WChunkRequest, WCookbookChunk } from "@cubby/recipebridge";
import {
  cookbookLlmUsageSchema,
  type chunkRequestInput,
  type chunkResponseOut,
  importRecipeSchema,
  importRecipesSchema,
} from "@cubby/schemas/import-recipe";
import { z } from "zod";

import { wasm } from "~/lib/wasm";

import { callChunkWithTransportRetry } from "./chunk-transport";

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

export type ExtractionProgress = z.output<typeof extractionProgressSchema>;
export type ExtractionReport = z.output<typeof extractionReportSchema>;
export type FailedChunk = z.output<typeof chunkFailure>;

export function failureMessage(chunk: FailedChunk): string {
  return chunk.fallback
    ? `Primary: ${chunk.primary.message}; fallback: ${chunk.fallback.message}`
    : chunk.primary.message;
}

/** The browser receives only validated recipes; wire details stay at this seam. */
export async function extractCookbook({
  chunks,
  source,
  concurrency,
  callChunk,
  onProgress,
  onDiagnostic,
}: {
  chunks: WCookbookChunk[];
  source: string;
  concurrency: number;
  callChunk: (
    input: z.output<typeof chunkRequestInput>,
  ) => Promise<z.output<typeof chunkResponseOut>>;
  onProgress: (progress: ExtractionProgress) => void;
  onDiagnostic: (message: string) => void;
}): Promise<ExtractionReport> {
  let reportedInvalidPreview = false;
  const report: unknown = await wasm.extract_cookbook(
    chunks,
    source,
    concurrency,
    (request: WChunkRequest, escalate: boolean) => {
      const input = {
        system: request.system,
        user: request.user,
        toolName: request.tool_name,
        toolSchema: z
          .record(z.string(), z.json())
          .parse(JSON.parse(request.tool_schema)),
        escalate,
      };
      return callChunkWithTransportRetry(() => callChunk(input));
    },
    (rawProgress: unknown) => {
      const progress = extractionProgressSchema.safeParse(rawProgress);
      if (progress.success) {
        onProgress(progress.data);
      } else if (!reportedInvalidPreview) {
        reportedInvalidPreview = true;
        onDiagnostic(
          "An extraction preview could not be validated. Keeping the last valid preview while extraction continues.",
        );
      }
    },
  );
  // A preview is advisory. The final report must validate before any extracted
  // recipes become available for import, including when some Chunks failed.
  return extractionReportSchema.parse(report);
}
