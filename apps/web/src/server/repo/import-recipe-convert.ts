import type { WAmount } from "@cubby/recipebridge";
import { type Amount, sanitizeSectionName } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type CookbookExtraction,
  type CookbookRecipe,
  flattenCookbookRecipes,
} from "@cubby/schemas/cookbook";
import { entityRefKey } from "@cubby/schemas/entity";
import type { IngredientShortcode, RecipeId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";

import {
  normalizeImportRecipe,
  normalizeImportTimes,
  normalizeImportYield,
} from "~/lib/import-recipe-normalizer";
import { wasm } from "~/lib/wasm";

import type { Database, DrizzleTransaction } from "../db";
import { withTransaction } from "./database-helpers";
import { findOrCreateIngredient } from "./ingredient/crud";
import {
  type CookbookRef,
  normalizeTitle,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe/crud";
import { lookupShortcodes } from "./shortcode-resolver";

const parsedAmountToInput = (parsed: WAmount): Amount => {
  const amount: Amount = { value: parsed.value, unit: parsed.unit };
  if (parsed.upper_value != null && parsed.upper_value > parsed.value) {
    amount.upperValue = parsed.upper_value;
  }
  return amount;
};

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
  // The stored book tree: a sub-recipe reference names its target by item id,
  // which resolves to a recipe through the target item's unique name.
  extraction: CookbookExtraction;
  // name.trim().toLowerCase() → committed ingredient id. Fills lazily: the first
  // recipe to use an ingredient pays the find-or-create round trip; the rest of
  // the book reuses it for free.
  ingredientIdByName: Map<string, IngredientShortcode>;
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
  sharedIds?: Map<string, IngredientShortcode>,
) => {
  const plain = new Map<string, Promise<IngredientShortcode>>();
  return {
    resolvePlain: (name: string): Promise<IngredientShortcode> => {
      const key = name.trim().toLowerCase();
      const cached = sharedIds?.get(key);
      if (cached) return Promise.resolve(cached);
      let p = plain.get(key);
      if (!p) {
        p = findOrCreateIngredient(exec, name).then((i) => {
          const shortcode = parseShortcodeFor("ingredient", i.shortcode);
          sharedIds?.set(key, shortcode);
          return shortcode;
        });
        plain.set(key, p);
      }
      return p;
    },
  };
};

/**
 * The converter from a raw `ImportRecipe` (scraper / Notion) into a
 * `RecipeCreateInput`: parses ingredient lines and the yield via WASM and
 * find-or-creates ingredients (memoized). Cookbook recipes take the other
 * path below; their lines arrive already parsed.
 */
const importRecipeToRecipeInput = async (
  cr: ImportRecipe,
  db: Database,
): Promise<RecipeCreateInput> => {
  const normalized = normalizeImportRecipe(cr);

  const build = async (
    exec: Database | DrizzleTransaction,
  ): Promise<RecipeCreateInput> => {
    const { resolvePlain } = makeIngredientResolvers(exec);
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
                const ingredientId = await resolvePlain(parsed.name);
                return {
                  type: "ingredient" as const,
                  ingredientId,
                  recipeId: null,
                  // Map the parser's WAmount (snake `upper_value`) to the persisted
                  // Amount (camel `upperValue`). The `> value` guard drops a
                  // degenerate equal range at the source.
                  amounts: parsed.amounts.map(parsedAmountToInput),
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

  return withTransaction(db, build);
};

/** The tree's `RecipeTimes` (snake_case, nullable) as the normalizer reads them. */
const cookbookTimes = (
  times: CookbookRecipe["meta"]["times"],
): ImportRecipe["meta"]["times"] =>
  times
    ? {
        active: times.active ?? undefined,
        total: times.total ?? undefined,
        prep: times.prep ?? undefined,
        cook: times.cook ?? undefined,
        active_minutes: times.active_minutes ?? undefined,
        total_minutes: times.total_minutes ?? undefined,
        prep_minutes: times.prep_minutes ?? undefined,
        cook_minutes: times.cook_minutes ?? undefined,
      }
    : undefined;

/** The notes markdown for a cookbook recipe: headnote, then labelled notes. */
const cookbookRecipeNotes = (item: CookbookRecipe): string | null =>
  composeNotesMarkdown(
    item.meta.description.join("\n\n"),
    item.notes.map((note) =>
      note.label ? `**${note.label}** ${note.text}` : note.text,
    ),
  );

/**
 * A recipe item from the extracted book tree → `RecipeCreateInput`. The
 * crate already parsed every ingredient line (`line.parsed`, the same
 * `WIngredient` shape the wasm parser returns) and resolved cross-recipe
 * references (`line.ref`, by item id); this converter only resolves
 * ingredient and recipe ids. A reference to a recipe not yet imported stays a
 * plain ingredient line, which is why callers import in dependency order.
 */
const cookbookRecipeToRecipeInput = async (
  item: CookbookRecipe,
  chapter: string | null,
  db: Database,
  importCtx: CookbookImportContext,
): Promise<RecipeCreateInput> => {
  const parsedYield = normalizeImportYield(item.meta.recipe_yield ?? undefined);
  const nameById = new Map(
    flattenCookbookRecipes(importCtx.extraction).map((entry) => [
      entry.recipe.id,
      entry.recipe.name,
    ]),
  );
  const targetRecipeIdFor = (targetId: string): RecipeId | undefined => {
    const name = nameById.get(targetId);
    return name ? importCtx.titleToId.get(normalizeTitle(name)) : undefined;
  };
  const equipment = item.meta.equipment.filter((line) => line.trim() !== "");
  const { resolvePlain } = makeIngredientResolvers(
    db,
    importCtx.ingredientIdByName,
  );
  return {
    name: item.name,
    meta: {
      url: null,
      times: normalizeImportTimes(cookbookTimes(item.meta.times)),
      equipment: equipment.length > 0 ? equipment : null,
      page: item.meta.page ?? null,
    },
    yield: parsedYield.yield,
    servings: parsedYield.servingsFromYield,
    notes: cookbookRecipeNotes(item),
    tags: chapter ? [chapter] : null,
    sections: await Promise.all(
      item.sections.map(async (section) => ({
        name: sanitizeSectionName(section.name),
        instructions: section.steps.map((step) => ({ instruction: step.text })),
        ingredients: await Promise.all(
          section.ingredients.map(async (line) => {
            const amounts = line.parsed.amounts.map((amount) =>
              parsedAmountToInput({
                unit: amount.unit,
                value: amount.value,
                upper_value: amount.upper_value ?? undefined,
              }),
            );
            const targetRecipeId =
              line.ref?.kind === "ingredient"
                ? targetRecipeIdFor(line.ref.target_id)
                : undefined;
            if (targetRecipeId) {
              const codes = await lookupShortcodes(db, [
                { entity: "recipe", id: targetRecipeId },
              ]);
              const recipeId = codes.get(
                entityRefKey("recipe", targetRecipeId),
              );
              if (!recipeId) {
                throw new Error(
                  `Recipe ${targetRecipeId} could not be resolved`,
                );
              }
              return {
                type: "recipe" as const,
                ingredientId: null,
                recipeId: parseShortcodeFor("recipe", recipeId),
                amounts,
                rawLine: line.raw,
                modifier: line.parsed.modifier ?? null,
              };
            }
            const ingredientId = await resolvePlain(line.parsed.name);
            return {
              type: "ingredient" as const,
              ingredientId,
              recipeId: null,
              amounts,
              rawLine: line.raw,
              modifier: line.parsed.modifier ?? null,
            };
          }),
        ),
      })),
    ),
  };
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
 * Upsert a recipe item from an extracted cookbook, scoped to its book so
 * re-imports upsert by (book, name). See {@link upsertCookbookRecipe}.
 *
 * Sub-recipe links come from the crate's resolved references: an ingredient
 * line whose `ref` targets a recipe already imported from this book becomes
 * a recipe-linked line. Import in dependency order (`topoOrder`) so forward
 * references resolve on the first pass.
 */
export const upsertCookbookRecipeFromCookbook = async (
  item: CookbookRecipe,
  chapter: string | null,
  cookbookRef: CookbookRef,
  db: Database,
  actor: ActorContext,
  importCtx: CookbookImportContext,
) => {
  const recipeInput = await cookbookRecipeToRecipeInput(
    item,
    chapter,
    db,
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
  importCtx.titleToId.set(normalizeTitle(recipeInput.name), result.id);

  return result;
};
