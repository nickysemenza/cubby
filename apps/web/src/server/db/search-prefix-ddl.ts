/**
 * Search accepts 100 UTF-16 code units; lowercasing can expand them. Prefixes
 * of 200 PostgreSQL characters cover that demand without indexing entire
 * retained identifiers. Overflow returns NULL and keeps the exhaustive matcher.
 * At most 1,024 prefixes of 200 characters fit below the 1 MB tsvector limit.
 */
// oxlint-disable-next-line cubby/no-raw-deleted-at-predicate -- Partial-index DDL requires literal, unqualified predicates rather than a runtime query helper.
export const searchPrefixDdl = (): string => `
CREATE OR REPLACE FUNCTION search_name_prefixes(names text[]) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  WITH prefixes AS MATERIALIZED (
    SELECT DISTINCT left(lower(value), 200) AS value
    FROM unnest(names) AS n(value)
    WHERE value IS NOT NULL AND value <> ''
    LIMIT 1025
  )
  SELECT CASE WHEN count(*) > 1024 THEN NULL
    ELSE array_to_tsvector(coalesce(array_agg(value), ARRAY[]::text[])) END
  FROM prefixes
$$;
CREATE INDEX IF NOT EXISTS "SearchDocument_name_prefix_gin_idx"
  ON "SearchDocument" USING gin(search_name_prefixes(aliases || keywords))
  WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "SearchDocument_name_prefix_overflow_idx"
  ON "SearchDocument" (id)
  WHERE "deletedAt" IS NULL AND search_name_prefixes(aliases || keywords) IS NULL;
`;
