import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type {
  ShoppingListContribution,
  ShoppingListItem,
  ShoppingListOut,
} from "@cubby/schemas/meal";

import { needText, shortText } from "./meal-format";

// The shared model behind every shopping-list renderer (desktop table, mobile
// cards, matrix). Membership, per-row need, status and order are decided here
// exactly once, so the three surfaces cannot disagree about what you need to
// buy.
//
// It stays React-free so it's testable as plain data. The coverage verdict and
// the epsilon it needs live in recipebridge (`availability_status_for`), so
// excluding a meal client-side can't drift from the server's own scoring.

export type ShoppingRow = {
  /** Stable per-ingredient key; also the check-off key. */
  key: string;
  item: ShoppingListItem;
  /** Need after meal exclusions. */
  need: number | null;
  /** Null when on-hand is unknown — see `shoppingListItem.shortfall`. */
  shortfall: number | null;
  status: IngredientAvailabilityStatus;
  isChecked: boolean;
};

/** An item's contributions from meals that are still switched on. */
export const visibleContributions = (
  item: ShoppingListItem,
  excluded: ReadonlySet<string>,
): ShoppingListContribution[] =>
  item.perMeal.filter((c) => !excluded.has(c.mealId));

/** Server-owned needs and membership; only check-off ordering is local. */
export const buildShoppingRows = (
  items: readonly ShoppingListItem[],
  checked: ReadonlySet<string>,
): ShoppingRow[] =>
  items
    .map((item) => {
      const key = item.ingredientId ?? item.name;
      return {
        key,
        item,
        need: item.needValue,
        shortfall: item.shortfall,
        status: item.status,
        isChecked: item.membership === "buy" && checked.has(key),
      };
    })
    .sort(
      (a, b) =>
        Number(a.isChecked) - Number(b.isChecked) ||
        (b.shortfall ?? 0) - (a.shortfall ?? 0) ||
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
) => {
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

/**
 * One check-off bucket, deliberately NOT keyed by date range.
 *
 * It used to be `…:${from}:${to}`, which meant nudging either end of the range
 * mid-shop silently swapped in an empty set and lost every tick — the one
 * moment the list is actually in use. Row keys are `ingredientId ?? name`
 * (`shoppingRowKey`), which don't depend on the range at all, so a single
 * bucket restores the ticks whatever window you land on. Ticks persist until
 * cleared explicitly; that's what `clear checked` is for.
 */
export const SHOPPING_CHECKED_STORAGE_KEY = "cubby:shopping-checked";

/**
 * The list as plain text, for the clipboard or a message.
 *
 * A pure function of the same rows the renderers draw, so the copied list and
 * the on-screen one can't diverge. Checked rows are kept and marked rather than
 * dropped: the point of copying mid-shop is to hand someone the whole list,
 * including what's already in the cart.
 */
export const shoppingRowsToText = (
  rows: readonly ShoppingRow[],
  range: { from: string; to: string },
  warnings: readonly string[] = [],
): string => {
  const lines: string[] = [`Shopping list · ${range.from} to ${range.to}`];
  for (const [membership, heading] of [
    ["buy", "To buy"],
    ["usuallyOnHand", "Usually on hand"],
    ["covered", "Recorded stock covers"],
  ] as const) {
    const section = rows.filter((row) => row.item.membership === membership);
    if (section.length === 0) continue;
    lines.push("", heading);
    for (const row of section) {
      const box = membership === "buy" ? (row.isChecked ? "[x] " : "[ ] ") : "";
      const quantity = membership === "buy" ? shortText(row) : needText(row);
      lines.push(
        `${box}${row.item.name} — ${quantity}${membership === "usuallyOnHand" ? " required (assumed available)" : ""}`,
      );
      if (row.item.quantityIssues.length > 0)
        lines.push(`  Quantity unresolved: ${needText(row)}`);
    }
  }
  if (warnings.length > 0)
    lines.push("", "Incomplete recipe information", ...warnings);
  return lines.join("\n");
};
