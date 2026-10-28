import { inArray, type SQL, type SQLWrapper, sql } from "drizzle-orm";

/** Normalize lookup input without rewriting retained names or their indexes. */
export const nameMatchKey = (value: string): string =>
  value.trim().toLowerCase();

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

/** Set-based identity joins enumerate the same stored name and alias keys. */
export const nameAliasKeysSql = (name: SQLWrapper, aliases: SQLWrapper): SQL =>
  sql`SELECT lower(matched_name.value) AS name FROM unnest(ARRAY[${name}] || ${aliases}) AS matched_name(value)`;

/** Keep lower(column) intact so declared exact-name indexes remain usable. */
export const nameMatchesAnySql = (
  column: SQLWrapper,
  names: readonly string[],
): SQL => {
  const keys = [...new Set(names.map(nameMatchKey).filter(Boolean))];
  return keys.length ? inArray(sql`lower(${column})`, keys) : sql`false`;
};

/** Eligibility, relevance and explanations use identical exact/prefix tiers. */
export const textArrayMatchSql = (input: {
  values: SQLWrapper;
  query: string;
  match: "exact" | "prefix";
}): SQL =>
  textArraySomeSql(input.values, (value) =>
    input.match === "exact"
      ? nameMatchesAnySql(value, [input.query])
      : sql`lower(${value}) LIKE ${`${nameMatchKey(input.query)}%`}`,
  );

export const nameOrAliasSql = (input: {
  name: SQLWrapper;
  aliases: SQLWrapper;
  names: readonly string[];
}): SQL =>
  sql`(${nameMatchesAnySql(input.name, input.names)} OR ${textArraySomeSql(input.aliases, (value) => nameMatchesAnySql(value, input.names))})`;
