import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/features";
import type { AiSelectionSpec } from "~/server/ai/selection";
import type { LocationPutAwayCandidate } from "~/server/repo/location";

/** Bound prompt size; tell the model when candidates are omitted. */
const MAX_LOCATION_CANDIDATES = 400;

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

/** Consumed by `FIELD_SUGGEST_REGISTRY["inventory.locationId"]`
 * (`server/ai/field-suggest/registry.ts`), which supplies its own roster
 * (`getLocationPutAwayCandidates`) and resolves the outcome itself. */
export const locationSuggestionSpec: AiSelectionSpec<LocationPutAwayCandidate> =
  {
    feature: FIELD_SUGGESTION_FEATURE,
    rules: LOCATION_SUGGESTION_RULES,
    idOf: (candidate) => candidate.id,
    renderLine: renderLocationCandidate,
    maxCandidates: MAX_LOCATION_CANDIDATES,
  };
