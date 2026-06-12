import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { normalizeImportRecipe } from "~/lib/import-recipe-normalizer";
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
  const plain = new Map<string, Promise<IngredientId>>();
  const link = new Map<RecipeId, Promise<IngredientId>>();
  return {
    resolvePlain: (name: string): Promise<IngredientId> => {
      const key = name.trim().toLowerCase();
      let p = plain.get(key);
      if (!p) {
        p = findOrCreateIngredient(tx, name).then((i) => i.id);
        plain.set(key, p);
      }
      return p;
    },
    resolveLink: (recipeId: RecipeId): Promise<IngredientId> => {
      let p = link.get(recipeId);
      if (!p) {
        p = findOrCreateRecipeLinkIngredient(tx, recipeId);
        link.set(recipeId, p);
      }
      return p;
    },
  };
};

/**
 * The one converter from a raw `ImportRecipe` (scraper / EPUB / Notion) into a
 * `RecipeCreateInput`: parses ingredient lines and the yield via WASM,
 * find-or-creates ingredients (memoized), and — only when importing into a
 * cookbook (`cookbookRef`) — links cross-recipe references (an ingredient `line`
 * matching one of the recipe's `references` whose target title already exists in
 * the book becomes a recipe-linked ingredient instead of a flat one).
 */
const importRecipeToRecipeInput = async (
  cr: ImportRecipe,
  db: Database,
  cookbookRef?: CookbookRef,
): Promise<RecipeCreateInput> => {
  // Cross-recipe linking is cookbook-only; scraper/Notion resolve everything flat.
  const lineToTitle = cookbookRef
    ? new Map(
        cr.references.map((r) => [r.line.trim(), r.title.trim().toLowerCase()]),
      )
    : new Map<string, string>();
  const titleToId = cookbookRef
    ? await getCookbookRecipeIdsByTitle(db, cookbookRef.id)
    : new Map<string, RecipeId>();

  const normalized = normalizeImportRecipe(cr);

  return await withTransaction(db, async (tx) => {
    const { resolvePlain, resolveLink } = makeIngredientResolvers(tx);
    return {
      name: normalized.name,
      meta: normalized.meta,
      yield: normalized.yield,
      servings: normalized.servings,
      notes: normalized.notes,
      sections: await Promise.all(
        normalized.sections.map(async (section) => ({
          name: section.name,
          instructions: section.instructions,
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
                ingredientId,
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

/** Upsert a scraped/imported recipe, keyed on name (the URL-scrape path). */
export const upsertImportRecipe = async (
  cr: ImportRecipe,
  db: Database,
  actor: ActorContext,
) => {
  const recipeInput = await importRecipeToRecipeInput(cr, db);
  return await upsertRecipe(recipeInput, db, actor);
};

/**
 * Upsert a recipe synced from a Notion page: convert + apply the Notion-column
 * tags (the recipe body carries no tags), then upsert keyed on the page id.
 */
export const upsertNotionRecipeFromImport = async (
  cr: ImportRecipe,
  pageId: string,
  tags: string[] | null,
  db: Database,
  actor: ActorContext,
) => {
  const recipeInput = await importRecipeToRecipeInput(cr, db);
  return await upsertNotionRecipe(
    { ...recipeInput, tags: tags && tags.length > 0 ? tags : null },
    pageId,
    db,
    actor,
  );
};

/**
 * Upsert a recipe extracted from an EPUB cookbook, scoped to its book so
 * re-imports upsert by (book, title). See {@link upsertCookbookRecipe}.
 *
 * The recipe's own `references` (recipe-epub's `resolve_references`) drive
 * sub-recipe linking: an ingredient line matching a reference whose target
 * recipe already exists in the book becomes a sub-recipe link instead of a flat
 * ingredient. Re-import after all the book's recipes exist to resolve forward
 * references.
 */
export const upsertCookbookRecipeFromCookbook = async (
  cr: ImportRecipe,
  cookbookRef: CookbookRef,
  db: Database,
  actor: ActorContext,
) => {
  const recipeInput = await importRecipeToRecipeInput(cr, db, cookbookRef);

  // (cookbookId, title)-scoped upsert + "Book" provenance + FK link.
  return await upsertCookbookRecipe(recipeInput, cookbookRef, db, actor);
};
