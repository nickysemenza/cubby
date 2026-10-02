import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { productRecipeCoverageChangesOut } from "@cubby/schemas/import-recipe";
import type { ProductUpdateInput } from "@cubby/schemas/product";
import { eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { z } from "zod";

import {
  product,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  bindShortcodeResolver,
  lookupEntityReferences,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";

const productShortcodes = bindShortcodeResolver("product");

/**
 * Product fields that feed a recipe line's price, weight or nutrient
 * derivation. Any other Product write (name, notes, images, stock flags)
 * cannot move coverage, so it skips the before/after costing reads.
 */
const COSTING_FIELDS = [
  "unitMappings",
  "price",
  "fdc_id",
  "labelNutrition",
  "ingredientId",
  "usdaUnavailable",
] as const;

/**
 * Bound on the recipes re-explained per Product write: each costs one full
 * `explainRecipe` before and after. The report says when it was cut.
 */
const COVERAGE_RECIPE_CAP = 25;

type Gap = "price" | "weight" | "nutrients";
const GAPS: readonly Gap[] = ["price", "weight", "nutrients"];
type CoverageChanges = z.output<typeof productRecipeCoverageChangesOut>;

type CheckedRecipe = {
  id: RecipeId;
  shortcode: CoverageChanges["closed"][number]["recipeId"];
  lineIds: ReadonlySet<string>;
};

type LineSnapshot = { name: string; missing: Gap[] };

const explainLines = async (
  context: EntityKernelContext,
  recipe: CheckedRecipe,
) => {
  const explain = await context.services.recipeCosting.explainRecipe(recipe.id);
  const lines = new Map<string, LineSnapshot>();
  for (const line of explain.computed.diagnostics) {
    if (!recipe.lineIds.has(line.id)) continue;
    lines.set(line.id, {
      name: line.name,
      missing: GAPS.filter((gap) => line.missing[gap]),
    });
  }
  return lines;
};

const linesOfIngredients = async (
  context: EntityKernelContext,
  ingredientIds: IngredientId[],
) => {
  const rows = await unwrapDb(context.db)
    .select({
      lineId: recipeSectionIngredient.id,
      recipeId: recipeSection.recipeId,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .where(inArray(recipeSectionIngredient.ingredientId, ingredientIds));
  // A soft-deleted recipe has no live shortcode reference and is not costed.
  const live = await lookupEntityReferences(
    context.db,
    "recipe",
    rows.map((row) => row.recipeId),
  );
  const byRecipe = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!live.has(row.recipeId)) continue;
    const lines = byRecipe.get(row.recipeId) ?? new Set<string>();
    lines.add(row.lineId);
    byRecipe.set(row.recipeId, lines);
  }
  const ordered = [...byRecipe.keys()].sort();
  const checked: CheckedRecipe[] = ordered
    .slice(0, COVERAGE_RECIPE_CAP)
    .map((recipeId) => ({
      id: parseEntityId("recipe", recipeId),
      shortcode: live.get(recipeId)!.id,
      lineIds: byRecipe.get(recipeId)!,
    }));
  return { checked, truncated: ordered.length > COVERAGE_RECIPE_CAP };
};

const snapshotRecipes = async (
  context: EntityKernelContext,
  recipes: CheckedRecipe[],
) =>
  Promise.all(recipes.map((recipe) => explainLines(context, recipe))).then(
    (lines) => new Map(recipes.map((recipe, i) => [recipe.id, lines[i]!])),
  );

/**
 * Snapshot, before a Product update, the coverage of every recipe line that
 * uses the Product's ingredient (current and incoming). Returns `null` when
 * the patch touches no costing field. The returned function re-reads the same
 * lines after the write and reports which lines closed or regressed.
 */
export async function beginProductCoverage(
  context: EntityKernelContext,
  productCode: string,
  data: ProductUpdateInput["data"],
): Promise<(() => Promise<CoverageChanges>) | null> {
  if (!COSTING_FIELDS.some((field) => data[field] !== undefined)) return null;

  const productId = await productShortcodes.one(context.db, productCode);
  const [current] = await unwrapDb(context.db)
    .select({ ingredientId: product.ingredientId })
    .from(product)
    .where(eq(product.id, productId));
  const incoming = data.ingredientId
    ? await resolveLiveShortcode(context.db, data.ingredientId, "ingredient")
    : null;
  const ingredientIds = uniq(
    [
      current?.ingredientId,
      incoming ? parseEntityId("ingredient", incoming) : null,
    ].filter((id): id is IngredientId => id != null),
  );
  const { checked, truncated } =
    ingredientIds.length > 0
      ? await linesOfIngredients(context, ingredientIds)
      : { checked: [], truncated: false };
  const before = await snapshotRecipes(context, checked);

  return async () => {
    const after = await snapshotRecipes(context, checked);
    const changes: CoverageChanges = {
      recipesChecked: checked.length,
      truncated,
      closed: [],
      regressed: [],
    };
    for (const recipe of checked) {
      for (const [lineId, was] of before.get(recipe.id)!) {
        const now = after.get(recipe.id)?.get(lineId);
        if (!now) continue;
        const entry = {
          recipeId: recipe.shortcode,
          id: lineId,
          name: now.name,
          before: was.missing,
          after: now.missing,
        };
        if (was.missing.some((gap) => !now.missing.includes(gap)))
          changes.closed.push(entry);
        if (now.missing.some((gap) => !was.missing.includes(gap)))
          changes.regressed.push(entry);
      }
    }
    return changes;
  };
}
