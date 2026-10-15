/**
 * How many recipes a cookbook's stored extraction holds — the number the
 * browse index, the `cookbook_import_incomplete` check and the partial-import
 * Problem compare live recipes against.
 *
 * Computed from `Cookbook.rawJson` on every read; nothing stores it. Two
 * stored shapes exist: the book tree (`{ chapters: [{ items: [...] }] }`,
 * counting the `kind: 'recipe'` items — what `flattenCookbookRecipes` counts)
 * and the pre-tree flat array (`needsReextract`), whose length is its recipe
 * count. Both are walked in SQL so a list, a filter and a check can never
 * disagree.
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

export const cookbookSourceRecipeCountSql = (rawJson: AnyColumn | SQL) =>
  sql<number>`(CASE WHEN jsonb_typeof(${rawJson}) = 'array'
    THEN jsonb_array_length(${rawJson})
    ELSE (
      SELECT count(*) FROM jsonb_array_elements(${rawJson}->'chapters') AS src_chapter,
        jsonb_array_elements(src_chapter->'items') AS src_item
      WHERE src_item->>'kind' = 'recipe'
    ) END)::int`;
