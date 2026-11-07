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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SearchDocument_name_prefix_gin_idx"
  ON "SearchDocument" USING gin(search_name_prefixes(aliases || keywords))
  WHERE "deletedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SearchDocument_name_prefix_overflow_idx"
  ON "SearchDocument" (id)
  WHERE "deletedAt" IS NULL AND search_name_prefixes(aliases || keywords) IS NULL;
--> statement-breakpoint
ANALYZE "SearchDocument";
