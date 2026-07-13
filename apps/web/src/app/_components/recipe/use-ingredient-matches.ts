import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";

/** A matched ingredient (DB row), or `null` when looked up but not found. */
export type IngredientMatch = {
  id: string;
  name: string;
  aliases: string[];
};

/** Lowercased ingredient name → match (or `null` = looked up, no match). A name
 * absent from the map means "not looked up yet" (still loading / disabled). */
export type IngredientMatchMap = Map<string, IngredientMatch | null>;

/**
 * Batched ingredient-name → DB-match lookup. One `ingredient.matchNames` query
 * for the whole `names` list (exact, case-insensitive, on name or alias) instead
 * of one `getByName` per name. Shared by the cookbook importer (per-recipe) and
 * the recipe form. Keep `names` scoped (e.g. one recipe's worth) so the request
 * stays under tRPC's dispatch size limit.
 */
export function useIngredientMatches(
  names: string[],
  opts?: { enabled?: boolean },
): { matchMap: IngredientMatchMap; isLoading: boolean } {
  const api = useTRPC();
  const uniqueNames = useMemo(
    () => uniq(names.filter((n) => n.length > 0)),
    [names],
  );
  const enabled = (opts?.enabled ?? true) && uniqueNames.length > 0;

  const { data, isLoading } = useQuery(
    api.ingredient.matchNames.queryOptions(
      { names: uniqueNames },
      { enabled, staleTime: 60_000 },
    ),
  );

  const matchMap = useMemo<IngredientMatchMap>(() => {
    const m: IngredientMatchMap = new Map();
    if (data) {
      for (const [name, match] of Object.entries(data)) {
        m.set(name.toLowerCase(), match);
      }
    }
    return m;
  }, [data]);

  return { matchMap, isLoading: enabled && isLoading };
}
