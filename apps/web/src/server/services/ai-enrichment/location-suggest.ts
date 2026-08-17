/**
 * "Where should this go?" — the put-away suggester behind the Add to Inventory
 * dialog's Suggest button.
 *
 * A service rather than a router callback because it spans three things: the
 * product repo (what is this), the location repo (what is the board), and a
 * model call, with a validation step that only makes sense holding all three.
 *
 * ## Why a model and not a ranking
 *
 * The counts on each candidate were backtested as a ranking against every
 * existing inventory entry and land the right location 22% of the time (37% in
 * the top three). They are weak because `tools` alone spreads over 72
 * locations with the leader holding 8% — the signal that actually decides it
 * is that a PACKOUT wall plate goes on the PACKOUT Wall, which is a read of the
 * location's NAME. So the counts go into the prompt as corroboration and the
 * model does the choosing.
 *
 * ## Why the id is re-derived
 *
 * The model is handed real shortcodes and asked to return one, but what comes
 * back is a string it typed. `resolveSuggestedLocation` matches it against the
 * candidate roster and returns THAT row's identity — shortcode, name, type and
 * ancestor chain, everything the picker renders; an unrecognized code fails
 * loudly rather than reaching the client as a live-looking id.
 *
 * Runs inline: a rare, user-initiated press is exactly the work the background
 * queue is not for.
 */

import type {
  LocationSuggestion,
  LocationSuggestionAiResult,
} from "@cubby/schemas/ai";
import type { ProductId } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getLocationPutAwayCandidates,
  type LocationPutAwayCandidate,
} from "~/server/repo/location";
import { getProductByID } from "~/server/repo/product";

/**
 * Locations per prompt. Well above the ~200 the house has, so today nothing is
 * dropped; it exists so a runaway roster degrades into a truncated prompt the
 * model is told about rather than an unbounded request.
 */
const MAX_LOCATION_CANDIDATES = 400;

/** `Garage > Shelving Unit > Shelf 3`, or just the name at top level. */
const candidatePath = (candidate: LocationPutAwayCandidate): string =>
  [...candidate.ancestors.map((a) => a.name), candidate.name].join(" > ");

/**
 * One line per location. Hints are omitted when zero rather than printed as
 * `0` — a roster where most lines end at the item count makes the few that
 * carry evidence stand out, and costs fewer tokens.
 */
export const formatLocationCandidates = (
  candidates: readonly LocationPutAwayCandidate[],
): string => {
  const shown = candidates.slice(0, MAX_LOCATION_CANDIDATES);
  const lines = shown.map((candidate) => {
    const hints: string[] = [];
    if (candidate.holdsProduct) hints.push("already stocked here");
    if (candidate.tagSiblings > 0)
      hints.push(`${candidate.tagSiblings} share tags`);
    if (candidate.manufacturerSiblings > 0)
      hints.push(`${candidate.manufacturerSiblings} same manufacturer`);
    if (candidate.categorySiblings > 0)
      hints.push(`${candidate.categorySiblings} same category`);

    const type = candidate.type ? ` (${candidate.type})` : "";
    const head = `${candidate.id} | ${candidatePath(candidate)}${type} - ${candidate.itemCount} items`;
    return hints.length > 0 ? `${head}; ${hints.join(", ")}` : head;
  });

  const omitted = candidates.length - shown.length;
  if (omitted > 0) {
    lines.push(`(${omitted} further locations omitted from this list)`);
  }
  return lines.join("\n");
};

/**
 * Match the model's answer back to a real location.
 *
 * Comparison is case- and whitespace-insensitive because the model is copying
 * a token out of prose; anything beyond that (a prefix match, a nearest name)
 * would be guessing on the model's behalf, which is the failure this function
 * exists to prevent.
 */
export const resolveSuggestedLocation = (
  candidates: readonly LocationPutAwayCandidate[],
  result: LocationSuggestionAiResult,
): LocationSuggestion => {
  const wanted = result.locationId.trim().toUpperCase();
  const match = candidates.find((c) => c.id.toUpperCase() === wanted);
  if (!match) {
    throw createAppError(
      "AI_SUGGESTION_UNUSABLE",
      `The location suggestion named "${result.locationId}", which is not one of the ${candidates.length} locations it was offered.`,
    );
  }
  return {
    location: {
      id: match.id,
      name: match.name,
      type: match.type,
      ancestors: match.ancestors,
    },
    confidence: result.confidence,
    reasoning: result.reasoning,
  };
};

export const suggestLocationForProduct = async (
  db: Database,
  productId: ProductId,
): Promise<LocationSuggestion> => {
  const product = await getProductByID(db, productId);
  if (!product) {
    throw createAppError("PRODUCT_NOT_FOUND", "Product not found.");
  }

  const candidates = await getLocationPutAwayCandidates(db, productId);
  if (candidates.length === 0) {
    throw createAppError(
      "LOCATION_NOT_FOUND",
      "There are no locations to suggest from yet.",
    );
  }

  const facts = [
    `Product: "${product.name}"`,
    product.manufacturer && product.manufacturer !== UNSPECIFIED_MANUFACTURER
      ? `Manufacturer: "${product.manufacturer}"`
      : null,
    product.model ? `Model: "${product.model}"` : null,
    product.category ? `Category: "${product.category}"` : null,
    product.tags.length > 0 ? `Tags: ${product.tags.join(", ")}` : null,
  ].filter((line): line is string => line !== null);

  const result = await getAnthropicClient().suggestLocation(
    facts.join("\n"),
    formatLocationCandidates(candidates),
    {
      db,
      feature: "location-suggestion",
      operation: "suggestLocation",
      cacheStatus: "none",
    },
  );

  return resolveSuggestedLocation(candidates, result);
};
