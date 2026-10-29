import type { SearchableEntity } from "@cubby/schemas/search";
import { type AnyColumn, sql, type SQL } from "drizzle-orm";

import { normalizeSearchText } from "~/lib/search-normalization";
import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayMatchSql } from "~/server/lib/name-alias-match";

/**
 * `SearchDocument` does not store the public code: an exact code hit is the
 * document whose entity holds it, read from the unique upper-case
 * `Entity.shortcode`. The scalar subquery is null for a non-code, so the arm
 * is false rather than an error.
 */
export const exactCodeMatch = (normalized: string): SQL =>
  sql`sd."entityId" = (SELECT e."id" FROM "Entity" e WHERE e."shortcode" = ${normalized.toUpperCase()})`;

/** Terms and prefix query are shared by command search and scoped list search. */
export const searchTerms = (query: string): string[] =>
  normalizeSearchText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export const buildPrefixTsQuery = (query: string): string =>
  searchTerms(query)
    .map((term) => `${term.replace(/[':&|!()]/g, "")} :*`.replace(" ", ""))
    .join(" & ");

/**
 * Any-token prefix query. `buildPrefixTsQuery` ANDs every token, so a longer
 * requested name ("Organic Example Fruit") never matches a shorter stored
 * one ("Example Fruit"); name resolution wants the ranked OR instead, where
 * `ts_rank_cd` puts the rows covering most tokens first.
 */
export const buildAnyPrefixTsQuery = (query: string): string =>
  searchTerms(query)
    .map((term) => `${term.replace(/[':&|!()]/g, "")}:*`)
    .join(" | ");

/** Indexed admission is a superset; the shared matcher still decides eligibility. */
export function indexedSearchArrayMatch(values: SQL, normalized: string): SQL {
  const match = textArrayMatchSql({
    values,
    query: normalized,
    match: "exact-or-prefix",
  });
  // Preserve LIKE's existing wildcard/escape behavior and uncapped internal calls.
  if (normalized.length > 200 || /[%_\\]/u.test(normalized)) return match;
  const prefix = sql`search_name_prefixes(${values})`;
  const query = `'${normalized.replaceAll("'", "''")}':*`;
  return sql`((${prefix} @@ ${query}::tsquery OR ${prefix} IS NULL) AND ${match})`;
}

/**
 * The deliberately uncapped lexical eligibility used by an entity list.
 *
 * Global command search applies a small fuzzy-candidate cap after using this
 * same vocabulary; a scoped list must not, because an otherwise matching row
 * on page two is still part of that list's truthful count and pagination.
 */
export const lexicalEligibility = (
  entity: SearchableEntity,
  entityId: AnyColumn,
  query: string | undefined,
): SQL | undefined => {
  const normalized = query === undefined ? "" : normalizeSearchText(query);
  const tsQuery = query === undefined ? "" : buildPrefixTsQuery(query);
  if (!normalized || !tsQuery) return undefined;
  return sql`EXISTS (
    SELECT 1
    FROM "SearchDocument" sd
    WHERE ${notDeleted("sd")}
      AND sd."entityKind" = ${entity}
      AND sd."entityId" = ${entityId}
      AND (
        ${exactCodeMatch(normalized)}
        OR lower(sd.title) = ${normalized}
        OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "exact" })}
        OR lower(sd.title) LIKE ${`${normalized}%`}
        OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "prefix" })}
        OR sd."searchVector" @@ to_tsquery('simple', ${tsQuery})
        OR (char_length(${normalized}) >= 3 AND sd."normalizedText" % ${normalized})
      )
  )`;
};

/** One scalar relevance expression, ordered exactly like the command search. */
export const lexicalRelevance = (
  entity: SearchableEntity,
  entityId: AnyColumn,
  query: string,
): SQL => {
  const normalized = normalizeSearchText(query);
  const tsQuery = buildPrefixTsQuery(query);
  return sql`(
    SELECT
      CASE WHEN ${exactCodeMatch(normalized)} THEN 0
           WHEN lower(sd.title) = ${normalized} THEN 1
           WHEN ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "exact" })} THEN 2
           WHEN lower(sd.title) LIKE ${`${normalized}%`} OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "prefix" })} THEN 3
           WHEN sd."searchVector" @@ to_tsquery('simple', ${tsQuery}) THEN 4
           ELSE 5 END * 1000000
      - ts_rank_cd(sd."searchVector", to_tsquery('simple', ${tsQuery})) * 1000
      - similarity(sd."normalizedText", ${normalized})
    FROM "SearchDocument" sd
    WHERE ${notDeleted("sd")}
      AND sd."entityKind" = ${entity}
      AND sd."entityId" = ${entityId}
    LIMIT 1
  )`;
};
