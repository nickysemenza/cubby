import type { RecomputeSummary } from "@cubby/schemas/recipe";

/**
 * Human phrase for a mutation's eager side-effects, e.g. "recomputed 3 recipes,
 * 2 valuations" — or "" when nothing downstream changed. One formatter so every
 * edit toast ("Saved · {this}") reads the same.
 */
const formatRecomputeSummary = (s: RecomputeSummary): string => {
  const parts: string[] = [];
  if (s.recipesRecomputed > 0) {
    parts.push(
      `${s.recipesRecomputed} recipe${s.recipesRecomputed === 1 ? "" : "s"}`,
    );
  }
  if (s.inventoryValuationsUpdated > 0) {
    parts.push(
      `${s.inventoryValuationsUpdated} valuation${s.inventoryValuationsUpdated === 1 ? "" : "s"}`,
    );
  }
  return parts.length > 0 ? `recomputed ${parts.join(", ")}` : "";
};

/** "Saved" with the recompute suffix appended when there is one. */
export const savedWithRecompute = (
  s: RecomputeSummary,
  base = "Saved",
): string => {
  const suffix = formatRecomputeSummary(s);
  return suffix ? `${base} · ${suffix}.` : `${base}.`;
};
