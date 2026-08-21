import { DATA_TYPE_PRIORITY } from "@cubby/usda-schemas";
import type { ListFoodsArgs } from "./types.js";

export function sqlOrderBy(orderBy: ListFoodsArgs["orderBy"]): string {
  switch (orderBy) {
    case "data_type":
      return "data_type";
    case "fdc_id":
      return "fdc_id";
    default:
      return "description";
  }
}

export function sqlDirection(direction: ListFoodsArgs["direction"]): string {
  return direction === "desc" ? "DESC" : "ASC";
}

// SQL CASE that maps `data_type` to the existing richness preference. Relevance
// search uses this only after textual fit and description specificity: data
// types describe different evidence sources, not a universal quality ladder.
// Only the four food types are spelled out; everything else (the rare,
// near-empty sampling/research records) falls to the ELSE bucket. Priorities are
// bind-safe integer literals from a trusted constant, and `column` is fixed by
// the caller rather than user input.
export function dataTypePriorityCase(column: string): string {
  const whens = (
    [
      "sr_legacy_food",
      "survey_fndds_food",
      "foundation_food",
      "branded_food",
    ] as const
  )
    .map((dt) => `WHEN '${dt}' THEN ${DATA_TYPE_PRIORITY[dt]}`)
    .join(" ");
  return `CASE ${column} ${whens} ELSE 99 END`;
}

// Backslash-escapes the SQL LIKE metacharacters (`%`, `_`, `\`) in a raw search
// term so user punctuation can't act as a wildcard in the prefix match below.
// Pairs with `... LIKE ? ESCAPE '\\'`.
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// SQL CASE that scores how closely a row's description matches the raw search
// term (lower = surfaced first). This is the "smart" tier that mimics USDA FDC's
// own search — it floats a literal "VANILLA BEAN" above noisy long descriptions
// like "VANILLA BEAN COCONUTMILK, VANILLA BEAN" that BM25 over-rewards because
// the query tokens repeat.
//
// Four tiers, because a bare prefix match isn't specific enough: FTS matches on
// `term*`, so searching "butter" also matches "Butterbur" (a Japanese
// vegetable), and since the tiers below it only compare description LENGTH,
// "Butterbur, canned" outranked "Butter, whipped, with salt" on brevity alone.
// Tier 1 requires the term to end at a word boundary — a space or a comma,
// which is how USDA separates a food from its qualifiers ("Butter, salted",
// "Butter oil, anhydrous") — so real butters sort above butterbur while the
// plain-prefix tier still catches everything else.
//
// FOUR `?` placeholders, bound in this order: the exact term, the two
// word-boundary patterns, then the plain prefix. `column` is a fixed column name
// (not a bind surface). Keep `matchQualityBindings` in sync.
export function matchQualityCase(column: string): string {
  return (
    `CASE WHEN ${column} = ? COLLATE NOCASE THEN 0` +
    ` WHEN ${column} LIKE ? ESCAPE '\\' OR ${column} LIKE ? ESCAPE '\\' THEN 1` +
    ` WHEN ${column} LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END`
  );
}

/** The bind values `matchQualityCase` expects, in SQL appearance order. */
export function matchQualityBindings(term: string): string[] {
  const escaped = escapeLike(term);
  return [term, `${escaped} %`, `${escaped},%`, `${escaped}%`];
}

// The four user-facing food types. The other five (agricultural_acquisition,
// market_acquisition, sample_food, sub_sample_food, experimental_food) are the
// Foundation sampling pipeline + research records — provenance, not pickable
// foods — which USDA FDC itself doesn't surface in food search.
export const FOOD_DATA_TYPES = [
  "branded_food",
  "foundation_food",
  "sr_legacy_food",
  "survey_fndds_food",
] as const;

// Builds the data_type SQL predicate + bind values for a given column.
// Precedence: an explicit single `dataTypeFilter` wins, then a multi-type
// `dataTypes` list (comma-joined), then `foodsOnly` (the user-facing food
// types). Returns empty sql when none apply (all types).
export function dataTypePredicate(
  column: string,
  dataTypeFilter: string | undefined,
  foodsOnly: boolean | undefined,
  dataTypes?: string,
): { sql: string; values: string[] } {
  if (dataTypeFilter) return { sql: `${column} = ?`, values: [dataTypeFilter] };
  const multi = (dataTypes ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (multi.length > 0) {
    return {
      sql: `${column} IN (${multi.map(() => "?").join(", ")})`,
      values: multi,
    };
  }
  if (foodsOnly) {
    return {
      sql: `${column} IN (${FOOD_DATA_TYPES.map(() => "?").join(", ")})`,
      values: [...FOOD_DATA_TYPES],
    };
  }
  return { sql: "", values: [] };
}
