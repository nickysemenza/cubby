import { z } from "zod";

// Mirrors the `CookbookRecipe` JSON emitted by `food-cli scrape-epub --json`
// (the `recipe-epub` crate in the ingredient-parser repo). Ingredient and
// instruction lines are raw strings — the server parses them on import, exactly
// like the URL scraper's CompactRecipe. Lenient by design: the LLM extractor
// omits empty metadata, so most fields are optional.

const cookbookRecipeTimes = z.object({
  active: z.string().optional(),
  total: z.string().optional(),
  prep: z.string().optional(),
  cook: z.string().optional(),
});

const cookbookRecipeMeta = z.object({
  title: z.string(),
  description: z.string().optional(),
  // Freeform yield line, e.g. "Makes 1 loaf" — NOT structured {value, unit}.
  recipe_yield: z.string().optional(),
  times: cookbookRecipeTimes.optional(),
  equipment: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  category: z.string().optional(),
  page: z.string().optional(),
});

/**
 * Compose a recipe's freeform `notes` markdown from an import source's
 * headnote (`description`) and tip list (`notes`): description as the opening
 * paragraph, notes as a bullet list. Null when both are empty/blank. Shared by
 * the server import paths and the client-side import preview so the preview
 * shows exactly what import will store.
 */
export const composeNotesMarkdown = (
  description: string | undefined | null,
  notes: readonly string[] | undefined | null,
): string | null => {
  const parts: string[] = [];
  const headnote = description?.trim();
  if (headnote) parts.push(headnote);
  const bullets = (notes ?? []).map((n) => n.trim()).filter(Boolean);
  if (bullets.length > 0) parts.push(bullets.map((n) => `- ${n}`).join("\n"));
  return parts.length > 0 ? parts.join("\n\n") : null;
};

const cookbookRecipeSection = z.object({
  name: z.string().optional(),
  ingredients: z.array(z.string()),
  instructions: z.array(z.string()).default([]),
});

// A detected reference from one recipe to another in the same cookbook
// (recipe-epub's `resolve_references()`): the verbatim ingredient `line` points
// at another recipe's `title`. `linked` = confirmed by an EPUB anchor href;
// `title_match` = the title appears in the line.
export const recipeRefSchema = z.object({
  title: z.string(),
  line: z.string(),
  confidence: z.enum(["linked", "title_match"]),
});
export type RecipeRef = z.infer<typeof recipeRefSchema>;

// TODO(hero-photos): recipe-epub's assembled CookbookRecipe carries an optional
// `image` (an `ImageRef` = in-archive `path` + `mime`, not bytes) for the recipe's
// hero photo. recipebridge currently emits it as None (see assemble_recipes), and
// cubby has no image-display wiring for cookbook imports, so it isn't modeled here
// yet. When wiring it up, add an optional `image` field below + materialize the
// bytes from the EPUB into a real URL on import.

export const cookbookRecipeSchema = z.object({
  meta: cookbookRecipeMeta,
  sections: z.array(cookbookRecipeSection),
  // The book label (food-cli passes the .epub path); provenance only.
  source: z.string().optional(),
  // Synthetic `source#doc_path`, not a real URL; provenance only.
  url: z.string().optional(),
  // Cross-recipe references (other recipes in the same book this one uses as
  // ingredients). Defaults to empty for older JSON without the field.
  references: z.array(recipeRefSchema).default([]),
  // NOTE: no `image` field yet — see the hero-photos TODO above.
});
export type CookbookRecipe = z.infer<typeof cookbookRecipeSchema>;

// What an uploaded `--json` file contains.
export const cookbookRecipesSchema = z.array(cookbookRecipeSchema);

// Optional power-user JSON-upload path: accept either the flat `CookbookRecipe[]`
// (what `food-cli` emits, and what the in-browser WASM extractor produces) or a
// `{ book, recipes }[]` bundle, normalizing both to a flat array. For a bundle
// entry, stamp its `book` onto each recipe's `source` so the importer's
// group-by-source logic is uniform. The primary drag-EPUB path doesn't touch
// this — it passes a flat `CookbookRecipe[]` straight from WASM.
const cookbookBundleEntry = z.object({
  book: z.string(),
  recipes: cookbookRecipesSchema,
});
export const cookbookBundleSchema = z
  .union([cookbookRecipesSchema, z.array(cookbookBundleEntry)])
  .transform((data): CookbookRecipe[] =>
    data.length > 0 && "recipes" in (data[0] as object)
      ? (data as z.infer<typeof cookbookBundleEntry>[]).flatMap((b) =>
          b.recipes.map((r) => ({ ...r, source: r.source ?? b.book })),
        )
      : (data as CookbookRecipe[]),
  );
