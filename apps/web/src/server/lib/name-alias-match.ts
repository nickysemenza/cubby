import {
  arrayOverlaps,
  inArray,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";

/**
 * Normalize lookup input without rewriting retained names or their indexes.
 * Unlike `statementMerchantKey` this keeps inner whitespace: SQL compares the
 * key with `lower(column)` (and `name_match_keys`) so declared exact-name
 * indexes stay usable, and stored names are not whitespace-collapsed. Each
 * raw merchant spelling is therefore resolved against Vendors on its own.
 */
const nameMatchKey = (value: string): string => value.trim().toLowerCase();

export const matchesNameOrAlias = (input: {
  name: string;
  aliases: readonly string[];
  query: string;
}): boolean => {
  const key = nameMatchKey(input.query);
  return (
    key.length > 0 &&
    [input.name, ...input.aliases].some((value) => value.toLowerCase() === key)
  );
};

/** One array-element owner for exact, lexical and domain-specific retrieval. */
export const textArraySomeSql = (
  values: SQLWrapper,
  predicate: (value: SQL) => SQL,
): SQL =>
  sql`EXISTS (SELECT 1 FROM unnest(${values}) AS matched_name(value) WHERE ${predicate(sql`matched_name.value`)})`;

/** Keep lower(column) intact so declared exact-name indexes remain usable. */
export const nameMatchesAnySql = (
  column: SQLWrapper,
  names: readonly string[],
): SQL => {
  const keys = [...new Set(names.map(nameMatchKey).filter(Boolean))];
  return keys.length ? inArray(sql`lower(${column})`, keys) : sql`false`;
};

/**
 * Exact element match on a `text[]` column: true when any lowercased element
 * equals a request key, as `textArraySomeSql` with `nameMatchesAnySql` does.
 * The overlap form is served by a `name_match_keys(column)` GIN index where
 * one is declared (Vendor), so a serializable read locks key pages instead of
 * the relation.
 */
export const textArrayMatchesAnySql = (
  values: SQLWrapper,
  names: readonly string[],
): SQL => {
  const keys = [...new Set(names.map(nameMatchKey).filter(Boolean))];
  return keys.length
    ? arrayOverlaps(sql`name_match_keys(${values})`, keys)
    : sql`false`;
};

/** Eligibility, relevance and explanations use identical exact/prefix tiers. */
export const textArrayMatchSql = (input: {
  values: SQLWrapper;
  query: string;
  match: "exact" | "prefix" | "exact-or-prefix";
}): SQL =>
  textArraySomeSql(input.values, (value) => {
    const exact = nameMatchesAnySql(value, [input.query]);
    const prefix = sql`lower(${value}) LIKE ${`${nameMatchKey(input.query)}%`}`;
    switch (input.match) {
      case "exact":
        return exact;
      case "prefix":
        return prefix;
      // A trailing backslash escapes LIKE's wildcard; equality remains its own tier.
      case "exact-or-prefix":
        return sql`(${exact} OR ${prefix})`;
    }
  });

export const nameOrAliasSql = (input: {
  name: SQLWrapper;
  aliases: SQLWrapper;
  names: readonly string[];
}): SQL =>
  sql`(${nameMatchesAnySql(input.name, input.names)} OR ${textArraySomeSql(input.aliases, (value) => nameMatchesAnySql(value, input.names))})`;
