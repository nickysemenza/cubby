// Enrichment-workbench review-queue proposal contracts.
//
// The workflow owns resolution, bounded concurrency, streaming, and failure
// handling. This module retains the shared output type used by that workflow.

import type { IngredientShortcode } from "@cubby/schemas/identifiers";

import type { IngredientMergeSuggestion } from "./ingredient-merge";
import type { UsdaFoodSuggestion } from "./usda-match";

/** One ingredient's pre-computed proposals, streamed as a `BulkProgressEvent` payload. */
export interface EnrichmentProposal {
  /**
   * The **shortcode**, matching what the client sent and what its cache is
   * keyed by. Returning the uuid here silently guaranteed a cache miss on every
   * proposal even once the input validated, so the review queue would still
   * have shown "precomputed 0/0".
   */
  id: IngredientShortcode;
  usda: UsdaFoodSuggestion;
  /** Null when merge wasn't requested for this row (no trigram candidate). */
  merge: IngredientMergeSuggestion | null;
}
