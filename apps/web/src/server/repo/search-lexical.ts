import type { SearchableEntity } from "@cubby/schemas/search";
import { type AnyColumn, sql, type SQL } from "drizzle-orm";

import { normalizeSearchText } from "~/server/semantic/text";

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
    WHERE sd."deletedAt" IS NULL
      AND sd."entityType" = ${entity}
      AND sd."entityId" = ${entityId}
      AND (
        lower(sd."shortcode") = ${normalized}
        OR lower(sd.title) = ${normalized}
        OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) = ${normalized})
        OR lower(sd.title) LIKE ${`${normalized}%`}
        OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) LIKE ${`${normalized}%`})
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
      CASE WHEN lower(sd."shortcode") = ${normalized} THEN 0
           WHEN lower(sd.title) = ${normalized} THEN 1
           WHEN EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) = ${normalized}) THEN 2
           WHEN lower(sd.title) LIKE ${`${normalized}%`} OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) LIKE ${`${normalized}%`}) THEN 3
           WHEN sd."searchVector" @@ to_tsquery('simple', ${tsQuery}) THEN 4
           ELSE 5 END * 1000000
      - ts_rank_cd(sd."searchVector", to_tsquery('simple', ${tsQuery})) * 1000
      - similarity(sd."normalizedText", ${normalized})
    FROM "SearchDocument" sd
    WHERE sd."deletedAt" IS NULL
      AND sd."entityType" = ${entity}
      AND sd."entityId" = ${entityId}
    LIMIT 1
  )`;
};
