import type { LocationSuggestion } from "@cubby/schemas/ai";
import type { ProductId } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";

import { LOCATION_SUGGESTION_FEATURE } from "~/server/ai/features";
import {
  type AiSelectionOutcome,
  type AiSelectionSpec,
  runAiSelection,
} from "~/server/ai/selection";
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
  select: typeof runAiSelection<LocationPutAwayCandidate>;
}

const productionLocationSuggestionAiPort: LocationSuggestionAiPort = {
  select: runAiSelection,
};

/** `Garage > Shelving Unit > Shelf 3`, or just the name at top level. */
const candidatePath = (candidate: LocationPutAwayCandidate): string =>
  [...candidate.ancestors.map((a) => a.name), candidate.name].join(" > ");

/** One roster line, with whichever hints have evidence. */
const renderLocationCandidate = (
  candidate: LocationPutAwayCandidate,
): string => {
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
};

/**
 * Render the full roster as text, capped at {@link MAX_LOCATION_CANDIDATES}
 * with a disclosure line when locations were omitted. Kept as a standalone,
 * independently-tested formatter (used by its own unit tests); the live
 * `suggestLocationForProduct` call renders through `locationSuggestionSpec`
 * instead, whose per-candidate line is the same `renderLocationCandidate`.
 */
export const formatLocationCandidates = (
  candidates: readonly LocationPutAwayCandidate[],
): string => {
  const shown = candidates.slice(0, MAX_LOCATION_CANDIDATES);
  const lines = shown.map(renderLocationCandidate);

  const omitted = candidates.length - shown.length;
  if (omitted > 0) {
    lines.push(`(${omitted} further locations omitted from this list)`);
  }
  return lines.join("\n");
};

const LOCATION_SUGGESTION_RULES = `You are a put-away assistant for a household inventory system. Given a product and the full roster of storage locations, choose the ONE location where the product should be stocked.

Each candidate is one line:
CODE | Room > Area > Shelf (type) - N items[; hints]

Rules:
1. Choose the ONE roster location the product belongs in.
2. The location NAMES and their parent chain are the primary signal. A product belongs with the system it is part of ("PACKOUT" plates on the "PACKOUT Wall", pantry goods in a pantry, fasteners in a hardware bin).
3. The hints ("3 share tags", "5 same manufacturer", "12 same category") are corroboration, not a ranking. A weakly-named location with a high count is a worse answer than a well-named one with none — a category is spread over dozens of locations.
4. "already stocked here" means the product is there now. Prefer it unless the product is one that gets deliberately split across places.
5. Prefer the most specific location that fits: a named shelf or bin over the room that contains it.
6. Decline only when no roster location fits at all.`;

export const locationSuggestionSpec: AiSelectionSpec<LocationPutAwayCandidate> =
  {
    feature: LOCATION_SUGGESTION_FEATURE,
    rules: LOCATION_SUGGESTION_RULES,
    idOf: (candidate) => candidate.id,
    renderLine: renderLocationCandidate,
    maxCandidates: MAX_LOCATION_CANDIDATES,
  };

/**
 * Shape a resolved `runAiSelection` outcome into the public
 * {@link LocationSuggestion}, or throw when the model named no usable
 * location. `runAiSelection` already resolved the answer against the roster,
 * so this half is just shaping the candidate and rejecting a miss.
 */
export const resolveLocationSuggestion = (
  outcome: AiSelectionOutcome<LocationPutAwayCandidate>,
  candidateCount: number,
): LocationSuggestion => {
  const { selected, confidence, reasoning } = outcome;
  if (!selected) {
    throw createAppError(
      "AI_SUGGESTION_UNUSABLE",
      `The location suggestion did not name one of the ${candidateCount} locations it was offered.`,
    );
  }
  return {
    location: {
      id: selected.id,
      name: selected.name,
      type: selected.type,
      ancestors: selected.ancestors,
    },
    confidence,
    reasoning,
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

  const outcome = await ai.select(locationSuggestionSpec, {
    subject: facts.join("\n"),
    candidates,
    usage: { db, operation: "suggestLocation", cacheStatus: "none" },
  });

  return resolveLocationSuggestion(outcome, candidates.length);
};
