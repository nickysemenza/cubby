/**
 * Exact name resolution compares lowercased `text[]` match values with
 * trimmed, lowercased request keys. `name_match_keys` is that element fold so
 * a GIN index can serve the alias arm; the function body uses only catalog
 * builtins because maintenance runs index expressions with a restricted
 * search_path. `fastupdate = off`: with a pending list every GIN scan
 * predicate-locks the metapage, so any insert would conflict with every
 * serializable lookup.
 */
// oxlint-disable-next-line cubby/no-raw-deleted-at-predicate -- Partial-index DDL requires literal, unqualified predicates rather than a runtime query helper.
export const nameMatchDdl = (): string => `
CREATE OR REPLACE FUNCTION name_match_keys(names text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT coalesce(array_agg(lower(value)), ARRAY[]::text[]) FROM unnest(names) AS n(value)
$$;
CREATE INDEX IF NOT EXISTS "Vendor_alias_keys_live_idx"
  ON "Vendor" USING gin(name_match_keys(aliases)) WITH (fastupdate = off)
  WHERE "deletedAt" IS NULL;
`;
