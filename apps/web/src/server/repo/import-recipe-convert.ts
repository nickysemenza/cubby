import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { normalizeImportRecipe } from "~/lib/import-recipe-normalizer";
import { wasm } from "~/lib/wasm";
import type { Database, DrizzleTransaction } from "../db";
import { withTransaction } from "./database-helpers";
import { findOrCreateIngredient } from "./ingredient/crud";
import {
  type CookbookRef,
  getCookbookRecipeIdsByTitle,
  normalizeTitle,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe/crud";
import { findOrCreateRecipeLinkIngredient } from "./recipe/update-helpers";

/**
 * Per-import shared state, threaded through the converter when importing a whole
 * cookbook (one context for the entire `importCookbookStream` /
 * `reprocessCookbookStream` loop). Both maps are read AND mutated as the loop
 * runs, so a forward sub-recipe reference and a repeated ingredient resolve
 * against work already committed by earlier recipes — turning per-recipe DB
 * reads into in-memory lookups. Absent for single-recipe callers (scrape /
 * Notion), which keep the original per-recipe behavior.
 */
export type CookbookImportContext = {
  // normalizeTitle(name) → recipe id. Seeded from the cookbook once, appended
  // after each upsert so forward cross-recipe references still link.
  titleToId: Map<string, RecipeId>;
  // name.trim().toLowerCase() → committed ingredient id. Fills lazily: the first
  // recipe to use an ingredient pays the find-or-create round trip; the rest of
  // the book reuses it for free.
  ingredientIdByName: Map<string, IngredientId>;
};

/**
 * Memoize ingredient resolution. The same ingredient can appear in multiple
 * sections (e.g. "almond extract" in both the Cake and Glaze of a recipe);
 * without memoization the parallel `Promise.all` fires two concurrent
 * find-or-create inserts for it, both SELECT-miss, and the second INSERT
 * violates the unique name index. Keying by normalized name (and recipe id for
 * sub-recipe links) collapses duplicates to one find-or-create.
 *
 * The optional `sharedIds` map (from a {@link CookbookImportContext}) extends
 * that memo across the *whole* import: a hit returns immediately with no DB
 * call, and every newly-resolved id is cached for later recipes. The executor
 * (`exec`) is the cookbook import's bare `db` (so each find-or-create commits
 * autonomously, keeping a cached id valid even when a later recipe is
 * error-isolated) or a single-recipe caller's transaction.
 */
const makeIngredientResolvers = (
  exec: Database | DrizzleTransaction,
  sharedIds?: Map<string, IngredientId>,
) => {
  const plain = new Map<string, Promise<IngredientId>>();
  const link = new Map<RecipeId, Promise<IngredientId>>();
  return {
    resolvePlain: (name: string): Promise<IngredientId> => {
      const key = name.trim().toLowerCase();
      const cached = sharedIds?.get(key);
      if (cached) return Promise.resolve(cached);
      let p = plain.get(key);
      if (!p) {
        p = findOrCreateIngredient(exec, name).then((i) => {
          sharedIds?.set(key, i.id);
          return i.id;
        });
        plain.set(key, p);
      }
      return p;
    },
    resolveLink: (recipeId: RecipeId): Promise<IngredientId> => {
      let p = link.get(recipeId);
      if (!p) {
        p = findOrCreateRecipeLinkIngredient(exec, recipeId);
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
  importCtx?: CookbookImportContext,
): Promise<RecipeCreateInput> => {
  // Cross-recipe linking is cookbook-only; scraper/Notion resolve everything flat.
  const lineToTitle = cookbookRef
    ? new Map(
        cr.references.map((r) => [r.line.trim(), r.title.trim().toLowerCase()]),
      )
    : new Map<string, string>();
  // Prefer the import context's running title map (seeded + appended per commit);
  // fall back to a one-shot read for the single-cookbook-recipe path.
  const titleToId = importCtx
    ? importCtx.titleToId
    : cookbookRef
      ? await getCookbookRecipeIdsByTitle(db, cookbookRef.id)
      : new Map<string, RecipeId>();

  const normalized = normalizeImportRecipe(cr);

  const build = async (
    exec: Database | DrizzleTransaction,
  ): Promise<RecipeCreateInput> => {
    const { resolvePlain, resolveLink } = makeIngredientResolvers(
      exec,
      importCtx?.ingredientIdByName,
    );
    return {
      name: normalized.name,
      meta: normalized.meta,
      yield: normalized.yield,
      servings: normalized.servings,
      notes: normalized.notes,
      sections: await Promise.all(
        normalized.sections.map(async (section) => {
          // One batch WASM call for the whole section instead of one per line
          // — output order matches input (parse_ingredient_lines contract),
          // so indexing by position below is safe.
          const parsedLines = wasm.parse_ingredient_lines(section.ingredients);
          return {
            name: section.name,
            instructions: section.instructions,
            ingredients: await Promise.all(
              section.ingredients.map(async (line, i) => {
                const parsed = parsedLines[i]!;
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
                  // Map the parser's WAmount (snake `upper_value`) to the persisted
                  // Amount (camel `upperValue`). The `> value` guard drops a
                  // degenerate equal range at the source.
                  amounts: parsed.amounts.map((a) => ({
                    value: a.value,
                    unit: a.unit,
                    ...(a.upper_value != null && a.upper_value > a.value
                      ? { upperValue: a.upper_value }
                      : {}),
                  })),
                  rawLine: line,
                  modifier: parsed.modifier ?? null,
                };
              }),
            ),
          };
        }),
      ),
    };
  };

  // Cookbook import: resolve against bare `db` so each ingredient/link commits
  // autonomously (no per-recipe BEGIN/COMMIT; cached ids stay valid across the
  // loop). Single-recipe callers keep the wrapping transaction.
  return importCtx ? await build(db) : await withTransaction(db, build);
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
  importCtx?: CookbookImportContext,
) => {
  const recipeInput = await importRecipeToRecipeInput(
    cr,
    db,
    cookbookRef,
    importCtx,
  );

  // (cookbookId, title)-scoped upsert + "Book" provenance + FK link.
  const result = await upsertCookbookRecipe(
    recipeInput,
    cookbookRef,
    db,
    actor,
  );

  // Record the committed (title → id) so a later recipe's forward reference to
  // this one resolves against the running map instead of a fresh DB read. Keyed
  // exactly like getCookbookRecipeIdsByTitle (normalizeTitle of the stored name,
  // which normalizeImportRecipe sets to meta.title).
  importCtx?.titleToId.set(normalizeTitle(recipeInput.name), result.id);

  return result;
};
