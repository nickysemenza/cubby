import { type CookbookId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { RecipeSource } from "@cubby/schemas/recipe-shared";
import { match, P } from "ts-pattern";

/**
 * Codec between a recipe's provenance discriminated union (`RecipeSource`, the
 * API shape) and the two DB columns (`SourceType` + `SourceData`). Kept in one
 * place so the stringly-typed pairing isn't reconstructed ad hoc across repos.
 * No migration: the columns are unchanged — this just gives the boundary a real
 * type and finally surfaces a Book recipe's book name in the API.
 */

type SourceColumns = {
  SourceType: string | null;
  SourceData: string | null;
  cookbookId?: string | null;
  cookbookShortcode?: string | null;
};

// Provenance override for recipes whose source isn't a website URL (e.g. EPUB
// cookbooks → SourceType "Book"). When omitted, source derives from meta.url.
// `cookbookId` is set only for Book recipes (the FK to their Cookbook); SourceData
// is kept synced to the cookbook name so the source codec stays a pure row read.
export type RecipeProvenance = {
  sourceType: "Book" | "Website" | "Other" | "Notion";
  sourceData: string | null;
  cookbookId?: CookbookId | null;
  cookbookShortcode?: string | null;
};

/** Tagged provenance → the DB column triple. The encode mirror of {@link recipeSourceFromDb}. */
export function recipeSourceToColumns(p: RecipeProvenance): {
  SourceType: "Book" | "Website" | "Other" | "Notion";
  SourceData: string | null;
  cookbookId: CookbookId | null;
} {
  return {
    SourceType: p.sourceType,
    SourceData: p.sourceData,
    cookbookId: p.cookbookId ?? null,
  };
}

/** The default provenance for recipes without an explicit source: a real URL → Website, else Other. */
export function webProvenance(url: string | null): RecipeProvenance {
  return url
    ? { sourceType: "Website", sourceData: url }
    : { sourceType: "Other", sourceData: null };
}

/**
 * The public Notion page URL for a page id (dashed or not). Notion accepts the
 * 32-char dashless id in the path, so we normalize to that.
 */
function notionUrlFromId(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/** DB columns → tagged union. Legacy/ambiguous rows decode to `{ type: "other" }`. */
export function recipeSourceFromDb({
  SourceType,
  SourceData,
  cookbookShortcode,
}: SourceColumns): RecipeSource {
  // `P.string.minLength(1)` preserves the original `&& SourceData` truthiness
  // guard: null and "" both fall through to `{ type: "other" }`.
  return (
    match({ SourceType, SourceData })
      .with(
        { SourceType: "Book", SourceData: P.string.minLength(1) },
        ({ SourceData }) => ({
          type: "book" as const,
          book: SourceData,
          cookbookId: cookbookShortcode
            ? parseShortcodeFor("cookbook", cookbookShortcode)
            : null,
        }),
      )
      .with(
        { SourceType: "Website", SourceData: P.string.minLength(1) },
        ({ SourceData }) => ({ type: "website" as const, url: SourceData }),
      )
      // Notion: SourceData holds the stable page id; derive the page URL for display.
      .with(
        { SourceType: "Notion", SourceData: P.string.minLength(1) },
        ({ SourceData }) => ({
          type: "notion" as const,
          pageId: SourceData,
          url: notionUrlFromId(SourceData),
        }),
      )
      .otherwise(() => ({ type: "other" as const }))
  );
}
