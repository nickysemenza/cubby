import type { Estimate, Extraction } from "@cubby/recipebridge";
import type {
  CookbookExtraction,
  CookbookRunReport,
} from "@cubby/schemas/cookbook";

import { asStoredCookbook, asStoredRunReport } from "~/lib/cookbook-types";

import type { BookEstimate } from "./types";

/** One finished run, in the shapes `upsertCookbook` takes. */
export type StoredExtraction = {
  cookbook: CookbookExtraction;
  report: CookbookRunReport;
};

/**
 * The crate's extraction result, restated in the server's vocabulary.
 *
 * No data changes: the conversions in `~/lib/cookbook-types` are identity, and
 * exist so `tsc` checks the crate's shapes against the schemas the server
 * validates with. See that module for why the two cannot be assigned directly.
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
