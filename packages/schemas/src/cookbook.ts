import { z } from "zod";
import { type ImportRecipe, importRecipesSchema } from "./import-recipe";

// Cookbook-specific upload shapes. The per-recipe carrier (`ImportRecipe`) and
// its helpers now live in `./import-recipe` — it's shared across all import
// sources (EPUB, URL scrape, Notion), not just cookbooks.

const cookbookBundleEntry = z.object({
  book: z.string(),
  recipes: importRecipesSchema,
});
type CookbookBundleEntry = z.infer<typeof cookbookBundleEntry>;

const isCookbookBundleEntry = (
  entry: ImportRecipe | CookbookBundleEntry,
): entry is CookbookBundleEntry => "recipes" in entry;

export const cookbookBundleSchema = z
  .union([importRecipesSchema, z.array(cookbookBundleEntry)])
  .transform((data): ImportRecipe[] =>
    data.flatMap((entry) =>
      isCookbookBundleEntry(entry)
        ? entry.recipes.map((recipe) => ({
            ...recipe,
            source: recipe.source ?? entry.book,
          }))
        : [entry],
    ),
  );
