// Enrichment-workbench review-queue pre-compute
//
// The review queue walks a backlog of unenriched ingredients one at a time and
// wants each row's AI proposals already on hand. This streams both proposals —
// the USDA food match and (only when asked) a merge candidate — across an
// arbitrarily long list, yielding one event per ingredient as it settles so the
// client can fill a cache ahead of the user. Read-only: it calls only the two
// read-only suggesters above and links/merges NOTHING. The user reviews and
// commits every write in the UI.

import type {
  IngredientId,
  IngredientShortcode,
} from "@cubby/schemas/identifiers";

import type { BulkProgressEvent } from "~/lib/bulk-progress";
import type { Database } from "~/server/db";
import type { USDAService } from "~/server/services/usda.service";

import {
  type IngredientMergeSuggestion,
  suggestIngredientMerge,
} from "./ingredient-merge";
import { suggestUsdaFood, type UsdaFoodSuggestion } from "./usda-match";

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

/**
 * Pre-compute USDA (and optional merge) proposals for a page of ingredients.
 * Runs windows of 5 concurrently — matching the per-name agent-loop concurrency
 * the batch suggesters use — and `yield`s a progress event per settled
 * ingredient so the client cache fills incrementally. A failed ingredient yields
 * a null-match proposal rather than aborting the page.
 */
export async function* precomputeEnrichmentProposals(
  usdaService: USDAService,
  db: Database,
  items: {
    /** Public id; echoed back as the proposal's key. */
    id: IngredientShortcode;
    /** Resolved by the router — the suggesters need the real row id. */
    ingredientId: IngredientId;
    name: string;
    wantUsda: boolean;
    wantMerge: boolean;
  }[],
): AsyncGenerator<
  BulkProgressEvent<EnrichmentProposal, { processed: number }>
> {
  const total = items.length;
  let done = 0;
  // An already-linked row needs no USDA match — skip the agent loop entirely.
  const skippedUsda: EnrichmentProposal["usda"] = {
    food: null,
    confidence: "low",
    reasoning: "",
  };
  yield { type: "progress", done, total };
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(async (item): Promise<EnrichmentProposal> => {
        const [usda, merge] = await Promise.all([
          item.wantUsda
            ? suggestUsdaFood(usdaService, db, item.name, {
                ingredientId: item.ingredientId,
              })
            : Promise.resolve(skippedUsda),
          item.wantMerge
            ? suggestIngredientMerge(db, {
                id: item.ingredientId,
                name: item.name,
              })
            : Promise.resolve(null),
        ]);
        return { id: item.id, usda, merge };
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      const res = settled[j]!;
      const item = batch[j]!;
      done++;
      const proposal: EnrichmentProposal =
        res.status === "fulfilled"
          ? res.value
          : {
              id: item.id,
              usda: {
                food: null,
                confidence: "low",
                reasoning: "Lookup failed.",
              },
              merge: null,
            };
      if (res.status === "rejected") {
        console.error(
          `[precomputeEnrichmentProposals] ${item.name} failed:`,
          res.reason,
        );
      }
      yield { type: "progress", done, total, item: proposal };
    }
  }
  yield { type: "done", result: { processed: done } };
}
