import { z } from "zod";

// The raw "import recipe" carrier: a recipe from any import source (EPUB cookbook
// via food-cli/WASM, the URL scraper, Notion) before it's parsed and resolved
// into the DB shape. Ingredient and instruction lines are raw strings — the
// server parses them on import. Lenient by design: extractors omit empty
// metadata, so most fields are optional.

const importRecipeTimes = z.object({
  active: z.string().optional(),
  total: z.string().optional(),
  prep: z.string().optional(),
  cook: z.string().optional(),
});

const importRecipeMeta = z.object({
  title: z.string(),
  description: z.string().optional(),
  // Freeform yield line, e.g. "Makes 1 loaf" — NOT structured {value, unit}.
  recipe_yield: z.string().optional(),
  times: importRecipeTimes.optional(),
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

const importRecipeSection = z.object({
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

// TODO(hero-photos): recipe-epub's assembled recipe carries an optional `image`
// (an `ImageRef` = in-archive `path` + `mime`, not bytes) for the recipe's hero
// photo. recipebridge currently emits it as None (see assemble_recipes), and
// cubby has no image-display wiring for cookbook imports, so it isn't modeled
// here yet. When wiring it up, add an optional `image` field below + materialize
// the bytes from the EPUB into a real URL on import.

export const importRecipeSchema = z.object({
  meta: importRecipeMeta,
  sections: z.array(importRecipeSection),
  // The book label (food-cli passes the .epub path); provenance only.
  source: z.string().optional(),
  // Synthetic `source#doc_path`, not a real URL; provenance only.
  url: z.string().optional(),
  // Cross-recipe references (other recipes in the same book this one uses as
  // ingredients). Defaults to empty for older JSON without the field.
  references: z.array(recipeRefSchema).default([]),
  // NOTE: no `image` field yet — see the hero-photos TODO above.
});
export type ImportRecipe = z.infer<typeof importRecipeSchema>;

// What an uploaded `--json` file / the WASM extractor produces.
export const importRecipesSchema = z.array(importRecipeSchema);
