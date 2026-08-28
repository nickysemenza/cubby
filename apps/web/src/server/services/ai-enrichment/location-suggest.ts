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

/** Bound prompt size; tell the model when candidates are omitted. */
const MAX_LOCATION_CANDIDATES = 400;

export interface LocationSuggestionAiPort {
  suggestLocation: ReturnType<typeof getAnthropicClient>["suggestLocation"];
}

const productionLocationSuggestionAiPort: LocationSuggestionAiPort = {
  suggestLocation: (...args) => getAnthropicClient().suggestLocation(...args),
};

/** `Garage > Shelving Unit > Shelf 3`, or just the name at top level. */
const candidatePath = (candidate: LocationPutAwayCandidate): string =>
  [...candidate.ancestors.map((a) => a.name), candidate.name].join(" > ");

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
  ai: LocationSuggestionAiPort = productionLocationSuggestionAiPort,
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

  const result = await ai.suggestLocation(
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
