import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type {
  ShoppingListContribution,
  ShoppingListItem,
  ShoppingListOut,
} from "@cubby/schemas/meal";
import { sumBy } from "es-toolkit";

// The shared model behind every shopping-list renderer (desktop table, mobile
// cards, matrix). Membership, per-row need, status and order are decided here
// exactly once, so the three surfaces cannot disagree about what you need to
// buy — and it stays pure (no React, no WASM) so it runs in the node `unit`
// vitest project.

export const SHOPPING_EPSILON = 1e-6;

export type ShoppingRow = {
  /** Stable per-ingredient key; also the check-off key. */
  key: string;
  item: ShoppingListItem;
  /** Need after meal exclusions. */
  need: number;
  shortfall: number;
  status: IngredientAvailabilityStatus;
  isChecked: boolean;
};

/** Recompute an item's status from its (post-exclusion) adjusted need. */
export const adjustedStatus = (
  item: ShoppingListItem,
  need: number,
): IngredientAvailabilityStatus => {
  // haveValue===null is either "missing" (no inventory) or "unconvertible"
  // (inventory exists but units don't reconcile) — keep the server's verdict
  // rather than collapsing both to "unconvertible".
  if (item.haveValue == null) return item.status;
  if (item.haveValue + SHOPPING_EPSILON >= need) return "ok";
  if (item.haveValue > 0) return "short";
  return "missing";
};

/** An item's contributions from meals that are still switched on. */
export const visibleContributions = (
  item: ShoppingListItem,
  excluded: ReadonlySet<string>,
): ShoppingListContribution[] =>
  item.perMeal.filter((c) => !excluded.has(c.mealId));

/**
 * Rows to shop for: need re-summed from the visible contributions so toggling a
 * meal off is instant (no refetch), checked rows sunk to the bottom, then
 * most-short-first.
 *
 * `have` is deliberately NOT re-summed — it's the ingredient's global on-hand,
 * counted once by the server. Re-deriving it per contribution is precisely the
 * double-count the aggregation exists to avoid.
 */
export const buildShoppingRows = (
  items: readonly ShoppingListItem[],
  excluded: ReadonlySet<string>,
  checked: ReadonlySet<string>,
): ShoppingRow[] =>
  items
    .map((item) => {
      const key = item.ingredientId ?? item.name;
      const need = sumBy(
        visibleContributions(item, excluded),
        (c) => c.needValue,
      );
      const have = item.haveValue ?? 0;
      return {
        key,
        item,
        need,
        shortfall: Math.max(0, need - have),
        status: adjustedStatus(item, need),
        isChecked: checked.has(key),
      };
    })
    .filter((r) => r.need > SHOPPING_EPSILON)
    .sort(
      (a, b) =>
        Number(a.isChecked) - Number(b.isChecked) ||
        b.shortfall - a.shortfall ||
        a.item.name.localeCompare(b.item.name),
    );

/** One column of the matrix: a single planned (meal, recipe) line. */
export type ShoppingLineColumn = {
  /** `lineIndex` as a string — see `shoppingListContribution.lineIndex`. */
  key: string;
  mealId: string;
  mealName: string | null;
  date: string;
  recipeId: string;
  recipeName: string;
  scale: number;
};

export type ShoppingMealGroup = {
  mealId: string;
  label: string;
  columnKeys: string[];
};

/**
 * The matrix's column axis, derived from the contributions themselves —
 * `meals[]` carries no recipes, so the planned lines only appear inside
 * `items[].perMeal`.
 *
 * Ordered by `meals[]` (date-sorted by the server) rather than by whichever
 * ingredient happened to mention a line first, then by recipe name. Keyed on
 * `lineIndex`, so a meal that plans the same recipe twice stays two columns
 * instead of silently collapsing into one.
 */
export const buildShoppingColumns = (
  data: Pick<ShoppingListOut, "meals" | "items">,
  excluded: ReadonlySet<string>,
): { columns: ShoppingLineColumn[]; groups: ShoppingMealGroup[] } => {
  // Widened to plain string: these are lookup/display keys, and the column
  // model deliberately isn't branded.
  const mealOrder = new Map<string, number>(
    data.meals.map((m, i) => [m.id, i] as const),
  );
  const byKey = new Map<string, ShoppingLineColumn>();

  for (const item of data.items) {
    for (const c of visibleContributions(item, excluded)) {
      const key = String(c.lineIndex);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        mealId: c.mealId,
        mealName: c.mealName,
        date: c.date,
        recipeId: c.recipeId,
        recipeName: c.recipeName,
        scale: c.scale,
      });
    }
  }

  const columns = [...byKey.values()].sort(
    (a, b) =>
      (mealOrder.get(a.mealId) ?? Number.MAX_SAFE_INTEGER) -
        (mealOrder.get(b.mealId) ?? Number.MAX_SAFE_INTEGER) ||
      a.recipeName.localeCompare(b.recipeName) ||
      a.key.localeCompare(b.key),
  );

  // Consecutive runs only — the sort above already puts a meal's lines
  // together, and gathering non-adjacent ones would mean reordering columns.
  const groups: ShoppingMealGroup[] = [];
  for (const column of columns) {
    const last = groups.at(-1);
    if (last && last.mealId === column.mealId) {
      last.columnKeys.push(column.key);
      continue;
    }
    groups.push({
      mealId: column.mealId,
      label: column.mealName || "Meal",
      columnKeys: [column.key],
    });
  }

  return { columns, groups };
};

/** Immutable Set toggle, shared by the exclude and check-off controls. */
export const toggleInSet = (
  set: ReadonlySet<string>,
  key: string,
): Set<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/** Check-off state is per date-range, so a return trip keeps what you grabbed. */
export const shoppingCheckedStorageKey = (from: string, to: string): string =>
  `cubby:shopping-checked:${from}:${to}`;
