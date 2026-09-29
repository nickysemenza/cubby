import { type CookbookId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { RecipeSource } from "@cubby/schemas/recipe-shared";
import { match, P } from "ts-pattern";

/**
 * Codec between a recipe's provenance discriminated union (`RecipeSource`, the
 * API shape) and where each kind of provenance is stored:
 *
 * - Website: `sourceUrl`.
 * - Book: the Cookbook row (`cookbookId`) names the book; a book with no
 *   Cookbook row keeps its title in `sourceLabel`.
 * - Notion: the page id is a `(notion, page)` EntityExternalId — the
 *   identity a re-import matches on.
 * - Other: nothing.
 *
 * Kept in one place so the pairing isn't reconstructed ad hoc across repos.
 */

type SourceColumns = {
  sourceType: string | null;
  sourceUrl: string | null;
  sourceLabel: string | null;
  cookbookName?: string | null;
  cookbookShortcode?: string | null;
  notionPageId?: string | null;
};

// Provenance override for recipes whose source isn't a website URL (e.g. EPUB
// cookbooks → sourceType "Book"). When omitted, source derives from meta.url.
// `sourceData` is the URL (Website), the book title (Book without a Cookbook
// row), or the page id (Notion); `cookbookId` is set only for Book recipes.
export type RecipeProvenance = {
  sourceType: "Book" | "Website" | "Other" | "Notion";
  sourceData: string | null;
  cookbookId?: CookbookId | null;
  cookbookShortcode?: string | null;
};

/**
 * Tagged provenance → the Recipe columns. A Notion page id is not a column:
 * the caller records it with `recordNotionRecipePage`.
 */
export function recipeSourceToColumns(p: RecipeProvenance) {
  const cookbookId = p.cookbookId ?? null;
  return {
    sourceType: p.sourceType,
    sourceUrl: p.sourceType === "Website" ? p.sourceData : null,
    sourceLabel:
      p.sourceType === "Book" && cookbookId === null ? p.sourceData : null,
    cookbookId,
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

/** Stored provenance → tagged union. Legacy/ambiguous rows decode to `{ type: "other" }`. */
export function recipeSourceFromDb({
  sourceType,
  sourceUrl,
  sourceLabel,
  cookbookName,
  cookbookShortcode,
  notionPageId,
}: SourceColumns): RecipeSource {
  const book = cookbookName ?? sourceLabel;
  return match({ sourceType, book, sourceUrl, notionPageId })
    .with(
      { sourceType: "Book", book: P.string.minLength(1) },
      ({ book: title }) => ({
        type: "book" as const,
        book: title,
        cookbookId: cookbookShortcode
          ? parseShortcodeFor("cookbook", cookbookShortcode)
          : null,
      }),
    )
    .with(
      { sourceType: "Website", sourceUrl: P.string.minLength(1) },
      ({ sourceUrl: url }) => ({ type: "website" as const, url }),
    )
    .with(
      { sourceType: "Notion", notionPageId: P.string.minLength(1) },
      ({ notionPageId: pageId }) => ({
        type: "notion" as const,
        pageId,
        url: notionUrlFromId(pageId),
      }),
    )
    .otherwise(() => ({ type: "other" as const }));
}
