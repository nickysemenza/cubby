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

// SQL CASE that maps the `data_type` column to a richness/preference rank
// (lower = surfaced first), so a name search leads with the most data-complete
// reference foods (SR Legacy > Survey > Foundation) before sparse branded label
// data. Only the four food types are spelled out; everything else (the rare,
// near-empty sampling/research records) falls to the ELSE bucket — so the
// expression is robust to raw-value spelling quirks in those types. Priorities
// are bind-safe (integer literals from a trusted constant), data_type is a fixed
// column name, so this is not a SQL-injection surface.
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
// term (lower = surfaced first): exact (case-insensitive) beats prefix beats
// everything else. This is the "smart" tier that mimics USDA FDC's own search —
// it floats a literal "VANILLA BEAN" above noisy long descriptions like
// "VANILLA BEAN COCONUTMILK, VANILLA BEAN" that BM25 over-rewards because the
// query tokens repeat. Two `?` placeholders: the exact term, then the escaped
// `term%` prefix pattern. `column` is a fixed column name (not a bind surface).
export function matchQualityCase(column: string): string {
  return `CASE WHEN ${column} = ? COLLATE NOCASE THEN 0 WHEN ${column} LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END`;
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
