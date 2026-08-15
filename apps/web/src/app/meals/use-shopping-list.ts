import type { ShoppingListOut, UnexpandedSubRecipe } from "@cubby/schemas/meal";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTRPC } from "~/integrations/trpc/react";
import { getDefaultShoppingRange } from "./meal-search";
import {
  buildShoppingColumns,
  buildShoppingRows,
  shoppingCheckedStorageKey,
  toggleInSet,
} from "./shopping-model";

/** Module-level so the empty case doesn't allocate a new array each render. */
const NO_GAPS: UnexpandedSubRecipe[] = [];
const NO_OMITTED: ShoppingListOut["omittedMeals"] = [];

/**
 * The shopping list's query + interaction state, owned above the renderer
 * switch so the table, the mobile cards and the matrix all read the same rows
 * and share one set of check marks.
 */
export function useShoppingList(from?: string, to?: string) {
  const api = useTRPC();

  const defaultRange = useMemo(() => getDefaultShoppingRange(), []);
  const fromStr = from ?? defaultRange.from;
  const toStr = to ?? defaultRange.to;

  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  // Stored as an array — Sets don't JSON-serialize.
  const [checkedKeys, setCheckedKeys] = useLocalStorage<string[]>(
    shoppingCheckedStorageKey(fromStr, toStr),
    [],
  );
  const checked = useMemo(() => new Set(checkedKeys), [checkedKeys]);

  const toggleChecked = useCallback(
    (key: string) =>
      setCheckedKeys((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
      ),
    [setCheckedKeys],
  );
  const toggleExcluded = useCallback(
    (mealId: string) => setExcludedKeys((s) => toggleInSet(s, mealId)),
    [],
  );

  const query = useQuery(
    // Date-only "YYYY-MM-DD" bounds — no timezone conversion.
    api.meal.getShoppingList.queryOptions({ from: fromStr, to: toStr }),
  );
  const { data } = query;

  const rows = useMemo(
    () => (data ? buildShoppingRows(data.items, excludedKeys, checked) : []),
    [data, excludedKeys, checked],
  );

  const { columns, groups } = useMemo(
    () =>
      data
        ? buildShoppingColumns(data, excludedKeys)
        : { columns: [], groups: [] },
    [data, excludedKeys],
  );

  // Exclusion-aware like `rows` and `columns`: switching a meal off removes its
  // ingredients from the list, so warning about what that meal couldn't break
  // down is noise about a gap you can no longer see.
  const unexpanded = useMemo(
    () =>
      data?.unexpanded.filter((u) => !excludedKeys.has(u.mealId)) ?? NO_GAPS,
    [data, excludedKeys],
  );

  return {
    ...query,
    rows,
    columns,
    groups,
    unexpanded,
    // Not exclusion-aware: these meals were never eligible to be excluded —
    // the server never offered them as columns in the first place.
    omittedMeals: data?.omittedMeals ?? NO_OMITTED,
    excluded: excludedKeys,
    toggleExcluded,
    checked,
    toggleChecked,
    remaining: rows.filter((r) => !r.isChecked).length,
    range: { from: fromStr, to: toStr },
  };
}
