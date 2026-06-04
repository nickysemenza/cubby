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
};

/** DB columns → tagged union. Legacy/ambiguous rows decode to `{ type: "other" }`. */
export function recipeSourceFromDb({
  SourceType,
  SourceData,
}: SourceColumns): RecipeSource {
  if (SourceType === "Book" && SourceData) {
    return { type: "book", book: SourceData };
  }
  if (SourceType === "Website" && SourceData) {
    return { type: "website", url: SourceData };
  }
  return { type: "other" };
}
