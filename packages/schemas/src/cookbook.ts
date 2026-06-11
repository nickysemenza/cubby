import { z } from "zod";
import { type ImportRecipe, importRecipesSchema } from "./import-recipe";

// Cookbook-specific upload shapes. The per-recipe carrier (`ImportRecipe`) and
// its helpers now live in `./import-recipe` — it's shared across all import
// sources (EPUB, URL scrape, Notion), not just cookbooks.

// Optional power-user JSON-upload path: accept either the flat `ImportRecipe[]`
// (what `food-cli` emits, and what the in-browser WASM extractor produces) or a
// `{ book, recipes }[]` bundle, normalizing both to a flat array. For a bundle
// entry, stamp its `book` onto each recipe's `source` so the importer's
// group-by-source logic is uniform. The primary drag-EPUB path doesn't touch
// this — it passes a flat `ImportRecipe[]` straight from WASM.
const cookbookBundleEntry = z.object({
  book: z.string(),
  recipes: importRecipesSchema,
});
export const cookbookBundleSchema = z
  .union([importRecipesSchema, z.array(cookbookBundleEntry)])
  .transform((data): ImportRecipe[] =>
    data.length > 0 && "recipes" in (data[0] as object)
      ? (data as z.infer<typeof cookbookBundleEntry>[]).flatMap((b) =>
          b.recipes.map((r) => ({ ...r, source: r.source ?? b.book })),
        )
      : (data as ImportRecipe[]),
  );
