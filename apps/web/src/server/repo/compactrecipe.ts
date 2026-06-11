import {
  type ParsedCompactRecipe,
  sanitizeSectionName,
} from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { wasm } from "~/lib/wasm";
import type { Database, DrizzleTransaction } from "../db";
import { withTransaction } from "./database-helpers";
import { findOrCreateIngredient } from "./ingredient";
import {
  type CookbookRef,
  findOrCreateRecipeLinkIngredient,
  getCookbookRecipeIdsByTitle,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe";

/**
 * Memoize ingredient resolution within a single recipe conversion. The same
 * ingredient can appear in multiple sections (e.g. "almond extract" in both the
 * Cake and Glaze of a recipe); without memoization the parallel `Promise.all`
 * fires two concurrent find-or-create inserts for it, both SELECT-miss, and the
 * second INSERT violates the unique name index (poisoning the transaction).
 * Keying by normalized name (and recipe id for sub-recipe links) collapses
 * duplicates to one find-or-create.
 */
const makeIngredientResolvers = (tx: DrizzleTransaction) => {
  const plain = new Map<string, Promise<string>>();
  const link = new Map<string, Promise<string>>();
  return {
    resolvePlain: (name: string): Promise<string> => {
      const key = name.trim().toLowerCase();
      let p = plain.get(key);
      if (!p) {
        p = findOrCreateIngredient(tx, name).then((i) => i.id);
        plain.set(key, p);
      }
      return p;
    },
    resolveLink: (recipeId: string): Promise<string> => {
      let p = link.get(recipeId);
      if (!p) {
        p = findOrCreateRecipeLinkIngredient(tx, recipeId);
        link.set(recipeId, p);
      }
      return p;
    },
  };
};

// Convert ParsedCompactRecipe to RecipeCreateInput format
const convertParsedCompactToRecipeInput = async (
  recipe: ParsedCompactRecipe,
  db: Database,
): Promise<RecipeCreateInput> => {
  return await withTransaction(db, async (tx) => {
    const { resolvePlain } = makeIngredientResolvers(tx);
    return {
      name: recipe.name,
      meta: {
        url: recipe.meta?.url ?? null,
      },
      yield: recipe.recipe_yield ?? null,
      servings: recipe.servings ?? null,
      notes: composeNotesMarkdown(recipe.description, null),
      sections: await Promise.all(
        recipe.sections.map(async (section) => ({
          name: section.name ?? null,
          instructions: section.instructions.map((instruction) => ({
            instruction,
          })),
          ingredients: await Promise.all(
            section.ingredients.map(async (ingredient) => ({
              type: "ingredient" as const,
              ingredientId: unsafeIngredientId(
                await resolvePlain(ingredient.name),
              ),
              recipeId: null,
              amounts: ingredient.amounts,
              rawLine: ingredient.rawLine ?? null,
              modifier: ingredient.modifier ?? null,
            })),
          ),
        })),
      ),
    };
  });
};

export const upsertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  db: Database,
  actor: ActorContext,
) => {
  // Convert compact recipe format to standard recipe input format
  const recipeInput = await convertParsedCompactToRecipeInput(recipe, db);

  // Use the centralized upsert logic
  return await upsertRecipe(recipeInput, db, actor);
};

/**
 * Upsert a recipe synced from a Notion page: convert + apply the Notion-column
 * tags (the compact body carries no tags), then upsert keyed on the page id.
 */
export const upsertNotionRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  pageId: string,
  tags: string[] | null,
  db: Database,
  actor: ActorContext,
) => {
  const recipeInput = await convertParsedCompactToRecipeInput(recipe, db);
  return await upsertNotionRecipe(
    { ...recipeInput, tags: tags && tags.length > 0 ? tags : null },
    pageId,
    db,
    actor,
  );
};

/**
 * Convert a raw `ImportRecipe` (the parser's JSON shape) directly into a
 * `RecipeCreateInput` — no `CompactRecipe` intermediary. Parses ingredient lines
 * and the freeform yield via WASM, find-or-creates ingredients (memoized), and
 * links cross-recipe references: when an ingredient `line` matches one of the
 * recipe's `references` whose target title already exists in this book, it
 * becomes a recipe-linked ingredient instead of a flat one.
 */
const importRecipeToRecipeInput = async (
  cr: ImportRecipe,
  cookbookRef: CookbookRef,
  db: Database,
): Promise<RecipeCreateInput> => {
  const lineToTitle = new Map(
    cr.references.map((r) => [r.line.trim(), r.title.trim().toLowerCase()]),
  );
  const titleToId = await getCookbookRecipeIdsByTitle(db, cookbookRef.id);

  // Freeform yield ("Makes about 12") → structured, via the same Rust parser
  // the web scraper uses. Omitted when unparseable.
  const parsedYield = cr.meta.recipe_yield
    ? wasm.parse_yield(cr.meta.recipe_yield)
    : undefined;

  return await withTransaction(db, async (tx) => {
    const { resolvePlain, resolveLink } = makeIngredientResolvers(tx);
    return {
      name: cr.meta.title,
      meta: { url: null },
      yield: parsedYield?.recipe_yield ?? null,
      servings: parsedYield?.servings ?? null,
      notes: composeNotesMarkdown(cr.meta.description, cr.meta.notes),
      sections: await Promise.all(
        cr.sections.map(async (section) => ({
          name: sanitizeSectionName(section.name),
          instructions: section.instructions.map((instruction) => ({
            instruction,
          })),
          ingredients: await Promise.all(
            section.ingredients.map(async (line) => {
              const parsed = wasm.parse_ingredient(line);
              const refTitle = lineToTitle.get(line.trim());
              const targetRecipeId = refTitle
                ? titleToId.get(refTitle)
                : undefined;
              // A reference whose target recipe exists in the book → link it.
              const ingredientId = targetRecipeId
                ? await resolveLink(targetRecipeId)
                : await resolvePlain(parsed.name);
              return {
                type: "ingredient" as const,
                ingredientId: unsafeIngredientId(ingredientId),
                recipeId: null,
                // Copy out of the readonly cached result into the mutable input.
                amounts: parsed.amounts.map((a) => ({ ...a })),
                rawLine: line,
                modifier: parsed.modifier ?? null,
              };
            }),
          ),
        })),
      ),
    };
  });
};

export const upsertCookbookRecipeFromCookbook = async (
  cr: ImportRecipe,
  cookbookRef: CookbookRef,
  db: Database,
  actor: ActorContext,
) => {
  const recipeInput = await importRecipeToRecipeInput(cr, cookbookRef, db);

  // (cookbookId, title)-scoped upsert + "Book" provenance + FK link.
  return await upsertCookbookRecipe(recipeInput, cookbookRef, db, actor);
};
