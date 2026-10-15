import type { Estimate, Extraction } from "@cubby/recipebridge/cookbook";
import type {
  CookbookExtraction,
  CookbookRunReport,
} from "@cubby/schemas/cookbook";

import {
  asStoredCookbook,
  asStoredRunReport,
} from "~/features/recipe/cookbook-import/cookbook-types";

import type { BookEstimate } from "./types";

/** One finished run, in the shapes `upsertCookbook` takes. */
export type StoredExtraction = {
  cookbook: CookbookExtraction;
  report: CookbookRunReport;
};

/**
 * The crate's extraction result, restated in the server's vocabulary.
 *
 * The book tree keeps its shape; the report normalizes upstream billing
 * evidence into the shared standard/charged accounting contract.
 */
export const asStoredExtraction = (
  extraction: Extraction,
): StoredExtraction => ({
  cookbook: asStoredCookbook(extraction.cookbook),
  report: asStoredRunReport(extraction.report),
});

/** Copy an estimate out of its wasm-owned object into plain render state. */
export const toBookEstimate = (estimate: Estimate): BookEstimate => ({
  chunks: estimate.chunks,
  lines: estimate.lines,
  inputTokens: estimate.input_tokens,
  outputTokens: estimate.output_tokens,
  costLow: estimate.cost_usd_low,
  costHigh: estimate.cost_usd_high,
  wallMsLow: estimate.wall_ms_low,
  wallMsHigh: estimate.wall_ms_high,
  ladder: [...estimate.ladder],
  concurrency: estimate.concurrency,
  assumptions: [...estimate.assumptions],
});
