import type { SubRecipeBlockReason } from "@cubby/schemas/availability";
import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type {
  RecipeGraphOut,
  RecipeOut,
  SectionIngredientOut,
} from "@cubby/schemas/recipe";

import type { RecipeCosting } from "~/lib/recipe-costing";

import {
  computeScalingPercentages,
  pickDefaultBaseRowId,
} from "./recipe-scaling-pct";

type RecipeTreeRecipe = RecipeOut | RecipeGraphOut;

export const recipeTreeDisplayImage = (
  recipe: RecipeTreeRecipe,
): ImageUrlSummary | null =>
  "displayImage" in recipe ? recipe.displayImage : (recipe.images[0] ?? null);

// Inject wasm ports so recipe export remains wasm-free. Root costing is already
// UI-scaled, so its cumulativeFactor is 1. Sub-recipes are costed at their
// native batch and use parent.factor * (asUsedGrams / childBatchGrams). The
// nested-spec view renders native batches; prep and combined shopping multiply
// by cumulativeFactor to render honest as-used amounts.

export type RecipeTreeRow =
  | {
      kind: "ingredient";
      id: string;
      row: SectionIngredientOut;
      grams: number | null;
      pct: number | null;
    }
  | {
      kind: "subrecipe";
      id: string;
      row: SectionIngredientOut;
      grams: number | null;
      pct: number | null;
      child: RecipeTreeNode;
    }
  | {
      kind: "stub";
      id: string;
      recipeId: RecipeShortcode;
      name: string;
      reason: "cycle" | "missing";
    };

type RecipeTreeSection = {
  id: string;
  name: string | null;
  rows: RecipeTreeRow[];
  steps: { n: number; text: string }[];
};

export type RecipeTreeNode = {
  recipe: RecipeTreeRecipe;
  costing: RecipeCosting | null;
  depth: number;
  cumulativeFactor: number;
  batchEstimated: boolean;
  batchEstimatedReason: SubRecipeBlockReason | null;
  batchGrams: number | null;
  baseRowId: string | null;
  sections: RecipeTreeSection[];
};

const numericGrams = (
  costing: RecipeCosting | null,
  rowId: string,
): number | null => {
  if (!costing) return null;
  const gram = costing.rows.find((r) => r.id === rowId)?.priceInfo?.gram;
  return gram?.isOk() ? gram.value.value : null;
};

type UnitAmount = { value: number; unit: string };

export type YieldFractionPort = (
  recipeYield: UnitAmount | null,
  amounts: readonly UnitAmount[],
) => { fraction: number | null; reason: SubRecipeBlockReason | null };

export type MassGramsPort = (amount: UnitAmount) => number | null;

export type YieldPorts = {
  yieldFraction: YieldFractionPort;
  massGrams: MassGramsPort;
};

export const buildRecipeTree = (
  root: RecipeOut,
  costingById: Map<string, RecipeCosting>,
  recipeMap: Record<string, RecipeTreeRecipe>,
  ports: YieldPorts,
): RecipeTreeNode => {
  const buildNode = (
    recipe: RecipeTreeRecipe,
    depth: number,
    cumulativeFactor: number,
    visited: ReadonlySet<RecipeShortcode>,
  ): RecipeTreeNode => {
    const costing = costingById.get(recipe.id) ?? null;
    const baseRowId = costing ? pickDefaultBaseRowId(costing) : null;
    const pctMap = costing
      ? computeScalingPercentages(costing, baseRowId)
      : new Map<string, number | null>();

    let n = 0;
    const sections: RecipeTreeSection[] = recipe.sections.map((section) => {
      const steps = section.instructions.map((ins) => ({
        n: ++n,
        text: ins.instruction,
      }));
      const rows: RecipeTreeRow[] = section.ingredients.map((ing) => {
        const grams = numericGrams(costing, ing.id);
        const pct = pctMap.get(ing.id) ?? null;
        if (ing.type !== "recipe") {
          return { kind: "ingredient", id: ing.id, row: ing, grams, pct };
        }
        const childId = ing.recipe.id;
        if (visited.has(childId)) {
          return {
            kind: "stub",
            id: ing.id,
            recipeId: childId,
            name: ing.recipe.name,
            reason: "cycle",
          };
        }
        const childRecipe = recipeMap[childId];
        if (!childRecipe) {
          return {
            kind: "stub",
            id: ing.id,
            recipeId: childId,
            name: ing.recipe.name,
            reason: "missing",
          };
        }
        // How much of the sub-recipe's batch this reference uses. The engine's
        // verdict is authoritative. When it declines, fall back to the costing
        // engine's own implied batch mass and flag the row — that fallback is
        // what the shopping list refuses to guess at, and it's defensible on a
        // prep sheet ("~130 g, estimated") in a way it isn't in a store aisle.
        const verdict = ports.yieldFraction(
          childRecipe.yield ?? null,
          ing.amounts,
        );
        let ratio = verdict.fraction;
        let estimated = false;
        let estimateReason: SubRecipeBlockReason | null = null;
        if (ratio == null) {
          const weightSum = costingById.get(childId)?.totals.weight ?? null;
          ratio =
            grams != null && weightSum != null && weightSum > 0
              ? grams / weightSum
              : null;
          estimated = true;
          estimateReason = verdict.reason;
        }
        const childFactor =
          ratio != null ? cumulativeFactor * ratio : cumulativeFactor;
        const child = buildNode(
          childRecipe,
          depth + 1,
          childFactor,
          new Set([...visited, childId]),
        );
        child.batchEstimated = estimated;
        child.batchEstimatedReason = estimateReason;
        return { kind: "subrecipe", id: ing.id, row: ing, grams, pct, child };
      });
      return { id: section.id, name: section.name, rows, steps };
    });

    return {
      recipe,
      costing,
      depth,
      cumulativeFactor,
      // Both are overwritten by the parent once it knows how its reference
      // resolved; a root has no reference, so it keeps these.
      batchEstimated: false,
      batchEstimatedReason: null,
      batchGrams: recipe.yield ? ports.massGrams(recipe.yield) : null,
      baseRowId,
      sections,
    };
  };

  return buildNode(root, 0, 1, new Set<RecipeShortcode>([root.id]));
};

export const flattenComponents = (root: RecipeTreeNode): RecipeTreeNode[] => {
  const seen = new Set<string>();
  const out: RecipeTreeNode[] = [];
  const visit = (node: RecipeTreeNode) => {
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind === "subrecipe") visit(row.child);
      }
    }
    if (!seen.has(node.recipe.id)) {
      seen.add(node.recipe.id);
      out.push(node);
    }
  };
  visit(root);
  return out;
};

export const firstExpansionRowIds = (root: RecipeTreeNode): Set<string> => {
  const seenRecipes = new Set<string>();
  const expand = new Set<string>();
  const walk = (node: RecipeTreeNode) => {
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind !== "subrecipe") continue;
        const recipeId = row.child.recipe.id;
        if (seenRecipes.has(recipeId)) continue;
        seenRecipes.add(recipeId);
        expand.add(row.id);
        walk(row.child);
      }
    }
  };
  walk(root);
  return expand;
};

export type CombinedNeed = {
  ingredientId: string;
  ingredientShortcode: string;
  name: string;
  grams: number | null;
  estimated: boolean;
};

export const asUsedGramsByRecipe = (
  root: RecipeTreeNode,
): Map<string, number> => {
  const map = new Map<string, number>();
  const walk = (node: RecipeTreeNode) => {
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind !== "subrecipe") continue;
        if (row.grams != null) {
          const id = row.child.recipe.id;
          map.set(id, (map.get(id) ?? 0) + row.grams * node.cumulativeFactor);
        }
        walk(row.child);
      }
    }
  };
  walk(root);
  return map;
};

type MatrixRow = {
  ingredientId: string;
  ingredientShortcode: string;
  name: string;
  byComponent: Map<string, number>;
  total: number;
  estimated: boolean;
};

export const buildIngredientMatrix = (root: RecipeTreeNode): MatrixRow[] => {
  const out: MatrixRow[] = [];
  const byId = new Map<string, MatrixRow>();

  for (const node of flattenComponents(root)) {
    for (const section of node.sections) {
      for (const row of section.rows) {
        // Only direct leaves — a sub-recipe is its own column, counted once.
        if (row.kind !== "ingredient" || row.row.type !== "ingredient")
          continue;
        const ingredientId = row.row.ingredient.id;
        const grams = row.grams; // native full-batch grams

        let r = byId.get(ingredientId);
        if (!r) {
          r = {
            ingredientId,
            ingredientShortcode: row.row.ingredient.id,
            name: row.row.ingredient.name,
            byComponent: new Map(),
            total: 0,
            estimated: false,
          };
          byId.set(ingredientId, r);
          out.push(r); // out keeps first-appearance order; r is mutated in place
        }
        if (grams != null) {
          r.byComponent.set(
            node.recipe.id,
            (r.byComponent.get(node.recipe.id) ?? 0) + grams,
          );
          r.total += grams;
        } else {
          r.estimated = true;
        }
      }
    }
  }

  return out;
};

/**
 * A component's batch size in grams — the mass yield when it has one, else the
 * resolved ingredient weight. Used to tell when a recipe consumes more than one
 * batch of a sub-recipe (`asUsedGramsByRecipe` ÷ this).
 */
export const batchYieldGrams = (node: RecipeTreeNode): number | null =>
  node.batchGrams ?? node.costing?.totals.weight ?? null;

/**
 * The full-batch shopping list: every component's batch summed by ingredient
 * (== the matrix row totals). This is what you buy to execute the prep sheet —
 * each sub-recipe batch counted once, not scaled down to its as-used portion.
 */
/** A component's full-batch leaf cost, carrying the engine's range. */
export type ComponentCost = { price: number; priceUpper: number };

export const fullBatchNeeds = (root: RecipeTreeNode): CombinedNeed[] =>
  buildIngredientMatrix(root).map((r) => ({
    ingredientId: r.ingredientId,
    ingredientShortcode: r.ingredientShortcode,
    name: r.name,
    grams: r.byComponent.size > 0 ? r.total : null,
    estimated: r.estimated,
  }));

/**
 * The full-batch shopping COST on the same axis as {@link fullBatchNeeds}: each
 * component's DIRECT leaf-ingredient price summed (sub-recipe rows excluded, so a
 * sub-recipe's cost is counted once — in its own column — not also rolled into
 * its parent). Per-component sums add up to `total`, mirroring the matrix's gram
 * subtotal row. Returns null costs when nothing priced in. Reads the resolved
 * `priceInfo.price` Result the same way {@link numericGrams} reads grams.
 *
 * Deliberately NOT `costing.totals.price`: that includes sub-recipe rows at
 * their as-used fraction, which on this per-component axis would count a
 * sub-recipe's cost twice — once in its own column and again inside its
 * parent's.
 *
 * Carries the upper bound the engine tracks, so a recipe with a ranged amount
 * ("2–3 cups") doesn't read as a point cost here while reading as a range
 * everywhere else. */
export const fullBatchCostByComponent = (root: RecipeTreeNode) => {
  const byComponent = new Map<string, ComponentCost>();
  let any = false;
  let anyUpper = false;
  for (const node of flattenComponents(root)) {
    const costing = node.costing;
    if (!costing) continue;
    let sum = 0;
    let sumUpper = 0;
    let has = false;
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind !== "ingredient") continue;
        const price = costing.rows.find((r) => r.id === row.id)?.priceInfo
          ?.price;
        if (price?.isOk()) {
          sum += price.value.value;
          // A row with no upper bound contributes its point value to both, so
          // the range collapses to the point when nothing in the component is
          // ranged.
          sumUpper += price.value.upper_value ?? price.value.value;
          if (price.value.upper_value != null) anyUpper = true;
          has = true;
          any = true;
        }
      }
    }
    if (has)
      byComponent.set(node.recipe.id, { price: sum, priceUpper: sumUpper });
  }
  let total: number | null = null;
  let totalUpper: number | null = null;
  if (any) {
    total = 0;
    totalUpper = 0;
    for (const v of byComponent.values()) {
      total += v.price;
      totalUpper += v.priceUpper;
    }
    if (!anyUpper) totalUpper = total;
  }
  return { byComponent, total, totalUpper };
};
