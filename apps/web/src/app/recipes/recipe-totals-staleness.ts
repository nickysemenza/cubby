/**
 * Staleness predicate for a recipe's persisted cost/calorie totals, used by the
 * recipe list to decide skeleton (drain plausibly still coming) vs a manual
 * "recompute" affordance (plausibly stuck). Pure + alias-free so it's unit
 * testable in the node "unit" project (a `.unit.test.ts` importing a `~/…` `.tsx`
 * fails there).
 */

// How long after a recipe's last edit we still assume the background drain is
// about to fill its totals. Within this window a null-totals cell shows the
// animated skeleton (work pending); past it, the recipe is plausibly STUCK (the
// drain never ran or failed for it) and we surface a manual recompute instead of
// an infinite skeleton.
export const TOTALS_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * A recipe with null totals whose last edit is old enough to look stuck. Takes
 * just the two fields it needs (structural) so it stays free of React / `~/`
 * imports. `totals` null/undefined = not yet computed; `now` is injectable for
 * tests (defaults to wall clock).
 */
export function totalsLookStuck(
  recipe: { totals?: unknown | null; updatedAt: Date },
  now: number = Date.now(),
): boolean {
  return (
    recipe.totals == null &&
    now - recipe.updatedAt.getTime() > TOTALS_STALE_AFTER_MS
  );
}
