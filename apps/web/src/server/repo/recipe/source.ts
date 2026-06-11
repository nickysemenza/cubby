import { type CookbookId, unsafeCookbookId } from "@cubby/schemas/identifiers";
import type { RecipeSource } from "@cubby/schemas/recipe";

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
};

// Provenance override for recipes whose source isn't a website URL (e.g. EPUB
// cookbooks → SourceType "Book"). When omitted, source derives from meta.url.
// `cookbookId` is set only for Book recipes (the FK to their Cookbook); SourceData
// is kept synced to the cookbook name so the source codec stays a pure row read.
export type RecipeProvenance = {
  sourceType: "Book" | "Website" | "Other" | "Notion";
  sourceData: string | null;
  cookbookId?: CookbookId | null;
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
export function notionUrlFromId(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/** DB columns → tagged union. Legacy/ambiguous rows decode to `{ type: "other" }`. */
export function recipeSourceFromDb({
  SourceType,
  SourceData,
  cookbookId,
}: SourceColumns): RecipeSource {
  if (SourceType === "Book" && SourceData) {
    return {
      type: "book",
      book: SourceData,
      cookbookId: cookbookId ? unsafeCookbookId(cookbookId) : null,
    };
  }
  if (SourceType === "Website" && SourceData) {
    return { type: "website", url: SourceData };
  }
  // Notion: SourceData holds the stable page id; derive the page URL for display.
  if (SourceType === "Notion" && SourceData) {
    return {
      type: "notion",
      pageId: SourceData,
      url: notionUrlFromId(SourceData),
    };
  }
  return { type: "other" };
}
