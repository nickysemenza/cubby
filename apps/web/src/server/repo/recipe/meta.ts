import type {
  RecipeMeta,
  RecipeStoredMeta,
} from "@cubby/schemas/recipe-shared";

/**
 * Codec between a recipe's API `meta` object and the three DB columns that back
 * it: `activeMinutes`, `totalMinutes`, and the `meta` jsonb.
 *
 * The split is not arbitrary. The two minute counts the recipe list sorts and
 * filters on are real integer columns so ordering and membership stay plain SQL
 * (a React-side filter over fetched rows would be wrong for a paginated list);
 * everything else — the four printed time strings, prep/cook minutes,
 * equipment, page — rides in the jsonb because nothing queries it.
 *
 * `meta.url` never round-trips through here: it is derived from
 * `SourceType`/`SourceData` on read (see `dbRecipeToTopLevelShape`) and written
 * through `recipeSourceToColumns` on write. Storing it here too would give
 * provenance two sources of truth.
 */

/** The subset of a Recipe row this codec reads. */
export type RecipeMetaColumns = {
  activeMinutes: number | null;
  totalMinutes: number | null;
  meta: RecipeStoredMeta | null;
};

const isBlank = (value: string | null | undefined): boolean =>
  value == null || value.trim() === "";

/**
 * API `meta` → the row columns. `undefined` in, all-null out, so a caller that
 * doesn't carry times clears nothing by accident — the caller decides whether to
 * spread the result (an explicit "reflect the source" write) or omit it.
 */
export const recipeMetaToColumns = (
  meta: RecipeMeta | null | undefined,
): RecipeMetaColumns => {
  const times = meta?.times;
  const equipment = meta?.equipment?.filter((line) => !isBlank(line)) ?? [];
  const stored: RecipeStoredMeta = {
    times: {
      active: times?.active ?? null,
      total: times?.total ?? null,
      prep: times?.prep ?? null,
      cook: times?.cook ?? null,
      prepMinutes: times?.prepMinutes ?? null,
      cookMinutes: times?.cookMinutes ?? null,
    },
    equipment: equipment.length > 0 ? equipment : null,
    page: isBlank(meta?.page) ? null : (meta?.page ?? null),
  };
  // Collapse an all-empty payload to a NULL column rather than storing a jsonb
  // object of nulls, so "has no metadata" is one representation, not two.
  const hasStored =
    Object.values(stored.times ?? {}).some((v) => v != null) ||
    stored.equipment != null ||
    stored.page != null;

  return {
    activeMinutes: times?.activeMinutes ?? null,
    totalMinutes: times?.totalMinutes ?? null,
    meta: hasStored ? stored : null,
  };
};

/**
 * Row columns → the API `meta`. `url` is supplied by the caller (the provenance
 * derivation), not read from the jsonb.
 */
export const recipeMetaFromColumns = (
  row: RecipeMetaColumns,
  url: string | null,
): RecipeMeta => ({
  url,
  times: {
    active: row.meta?.times?.active ?? null,
    total: row.meta?.times?.total ?? null,
    prep: row.meta?.times?.prep ?? null,
    cook: row.meta?.times?.cook ?? null,
    activeMinutes: row.activeMinutes,
    totalMinutes: row.totalMinutes,
    prepMinutes: row.meta?.times?.prepMinutes ?? null,
    cookMinutes: row.meta?.times?.cookMinutes ?? null,
  },
  equipment: row.meta?.equipment ?? null,
  page: row.meta?.page ?? null,
});
