import type { RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import type { RecipeCosting } from "~/lib/recipe-costing";
import {
  computeScalingPercentages,
  pickDefaultBaseRowId,
} from "./recipe-scaling-pct";

// A recipe expanded into its full sub-recipe tree for the prep-sheet and
// nested-spec views. Pure + alias-free (only type-only imports from
// recipe-costing, and the already-pure recipe-scaling-pct helpers) so it stays
// unit-testable in the node "unit" vitest project. The wasm-bound display
// formatting (buildDisplayQuantities) is applied by the views at render — this
// module carries only structure + numbers.
//
// Two scaling representations coexist on purpose:
//   - The ROOT node is the *scaled* recipe (RecipeDetail multiplies amounts
//     upstream), so its costing grams already include the UI scale. Its
//     `cumulativeFactor` is therefore 1.
//   - SUB-recipe nodes are costed at their *native* batch. A sub's
//     `cumulativeFactor` = parent.factor × (asUsedGrams ÷ childBatchGrams), so
//     multiplying a sub's native leaf grams by it yields the as-used,
//     UI-scaled amount (the UI scale rides in via the root's asUsedGrams).
// The nested-spec view shows each node at its own batch (native % base); the
// prep view + combined-shop use `cumulativeFactor` for honest as-used numbers.

export type RecipeTreeRow =
  | {
      kind: "ingredient";
      id: string;
      row: SectionIngredientOut;
      /** Resolved grams within THIS node's batch, or null when unweighable. */
      grams: number | null;
      /** Scaling % vs this node's base row, or null. */
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
      recipeId: RecipeId;
      name: string;
      /** Why the sub-recipe wasn't expanded. */
      reason: "cycle" | "missing";
    };

type RecipeTreeSection = {
  id: string;
  name: string | null;
  rows: RecipeTreeRow[];
  /** Steps numbered continuously across this node's sections. */
  steps: { n: number; text: string }[];
};

export type RecipeTreeNode = {
  recipe: RecipeOut;
  costing: RecipeCosting | null;
  /** 0 = root. */
  depth: number;
  /** Multiply this node's native leaf grams to get the as-used, UI-scaled amount. */
  cumulativeFactor: number;
  /** True when the factor couldn't be derived (missing as-used/batch weight). */
  batchEstimated: boolean;
  /** This node's 100%-base row id (flour, else heaviest), for the spec view. */
  baseRowId: string | null;
  sections: RecipeTreeSection[];
};

/** Resolved numeric grams for a costing row, or null when it can't reach grams. */
const numericGrams = (
  costing: RecipeCosting | null,
  rowId: string,
): number | null => {
  if (!costing) return null;
  const gram = costing.rows.find((r) => r.id === rowId)?.priceInfo?.gram;
  return gram?.isOk() ? gram.value.value : null;
};

// Mass-unit → grams, for converting a sub-recipe's yield into the batch
// denominator. The engine scales a sub-recipe by (amount used ÷ yield), so the
// denominator must be the YIELD in grams — not the ingredient-weight sum, which
// diverges sharply for anything that loses water in cooking (a 4.5 lb bird →
// 800 g of meat). Non-mass yields (servings, loaves, cups) aren't convertible
// here, so those fall back to the ingredient-weight sum + a `batchEstimated` flag.
const MASS_TO_GRAMS: Record<string, number> = {
  mg: 0.001,
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

/** A recipe's yield expressed in grams, or null when its unit isn't a mass. */
const yieldGrams = (recipe: RecipeOut): number | null => {
  const y = recipe.yield;
  if (!y?.value) return null;
  const factor = MASS_TO_GRAMS[y.unit.toLowerCase().trim()];
  return factor != null ? y.value * factor : null;
};

/**
 * For a non-mass yield ("8 servings", "2 loaves"), the engine scales a
 * sub-recipe by matching the reference amount's unit to the yield's unit
 * (e.g. "2 servings" of an "8 servings" batch → 1/4). Returns that ratio when a
 * reference amount shares the yield's unit, else null.
 */
const yieldUnitRatio = (
  recipe: RecipeOut,
  amounts: readonly { value: number; unit: string }[],
): number | null => {
  const y = recipe.yield;
  if (!y?.value) return null;
  const unit = y.unit.toLowerCase().trim();
  const match = amounts.find((a) => a.unit.toLowerCase().trim() === unit);
  return match ? match.value / y.value : null;
};

/**
 * Expand `root` (already scaled) plus its `recipeMap` sub-recipe closure (native)
 * into a tree. `costingById` must hold a costing per recipe id — produced by
 * calling `computeRecipeCosting([scaledRoot, ...Object.values(recipeMap)], …)`.
 * Cycles are guarded per-path and rendered as `stub` rows.
 */
export const buildRecipeTree = (
  root: RecipeOut,
  costingById: Map<string, RecipeCosting>,
  recipeMap: Record<string, RecipeOut>,
): RecipeTreeNode => {
  const buildNode = (
    recipe: RecipeOut,
    depth: number,
    cumulativeFactor: number,
    visited: ReadonlySet<RecipeId>,
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
        // How much of the sub-recipe's batch this reference uses. Best: as-used
        // grams ÷ yield-in-grams (what the engine scales against). Next: a
        // unit-ratio for non-mass yields ("2 of 8 servings"). Last resort: the
        // ingredient-weight sum — approximate for cooked items, so flag it.
        const yieldDenom = yieldGrams(childRecipe);
        const unitRatio = yieldUnitRatio(childRecipe, ing.amounts);
        let ratio: number | null = null;
        let estimated = false;
        if (grams != null && yieldDenom != null && yieldDenom > 0) {
          ratio = grams / yieldDenom;
        } else if (unitRatio != null && Number.isFinite(unitRatio)) {
          ratio = unitRatio;
        } else {
          const weightSum = costingById.get(childId)?.totals.weight ?? null;
          if (grams != null && weightSum != null && weightSum > 0) {
            ratio = grams / weightSum;
          }
          estimated = true;
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
        return { kind: "subrecipe", id: ing.id, row: ing, grams, pct, child };
      });
      return { id: section.id, name: section.name, rows, steps };
    });

    return {
      recipe,
      costing,
      depth,
      cumulativeFactor,
      batchEstimated: false,
      baseRowId,
      sections,
    };
  };

  return buildNode(root, 0, 1, new Set<RecipeId>([root.id]));
};

/**
 * The tree's nodes in prep order: every sub-recipe before the recipe that uses
 * it (post-order), deduped by recipe id, with the root assembly last. This is
 * the component order a prep sheet wants — make the dependencies, then assemble.
 */
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

/**
 * The set of sub-recipe ROW ids that get the full inline expansion: each
 * distinct sub-recipe is expanded only on its first occurrence in render order;
 * later references collapse to a "see above" pointer. Shared by the nested-spec
 * view and the markdown exporter so both agree on which rows are "first".
 */
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

/** One ingredient's full-batch shopping need across all components. */
export type CombinedNeed = {
  ingredientId: string;
  name: string;
  /** Summed full-batch grams, or null when nothing weighed in. */
  grams: number | null;
  /** True when a contribution had no resolvable weight. */
  estimated: boolean;
};

/**
 * Per sub-recipe id, the total UI-scaled grams used across all its references
 * (used in 3 places → all 3 summed). The root isn't included. Powers the prep
 * sheet's "X used" note: each component shows its full batch, this says how much
 * of it this recipe actually consumes.
 */
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

/**
 * One ingredient row of the matrix: its per-component grams + a row total. The
 * columns are the tree's {@link flattenComponents}, keyed by recipe id.
 */
type MatrixRow = {
  ingredientId: string;
  name: string;
  /** componentRecipeId → full-batch grams that component contributes. */
  byComponent: Map<string, number>;
  /** Sum across components — the ingredient's full-batch shopping total. */
  total: number;
  estimated: boolean;
};

/**
 * Pivot the tree into ingredient rows at FULL BATCH. Each distinct component
 * (deduped — you make one batch even if a sub-recipe is used 3×) contributes its
 * own direct leaf ingredients at native amounts; sub-recipes are their own
 * columns, not folded in. A row's `total` is therefore what you actually shop
 * for. Columns are {@link flattenComponents} (dependencies first); rows follow
 * first appearance.
 */
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
  yieldGrams(node.recipe) ?? node.costing?.totals.weight ?? null;

/**
 * The full-batch shopping list: every component's batch summed by ingredient
 * (== the matrix row totals). This is what you buy to execute the prep sheet —
 * each sub-recipe batch counted once, not scaled down to its as-used portion.
 */
export const fullBatchNeeds = (root: RecipeTreeNode): CombinedNeed[] =>
  buildIngredientMatrix(root).map((r) => ({
    ingredientId: r.ingredientId,
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
 * `priceInfo.price` Result the same way {@link numericGrams} reads grams. */
export const fullBatchCostByComponent = (
  root: RecipeTreeNode,
): { byComponent: Map<string, number>; total: number | null } => {
  const byComponent = new Map<string, number>();
  let any = false;
  for (const node of flattenComponents(root)) {
    const costing = node.costing;
    if (!costing) continue;
    let sum = 0;
    let has = false;
    for (const section of node.sections) {
      for (const row of section.rows) {
        if (row.kind !== "ingredient") continue;
        const price = costing.rows.find((r) => r.id === row.id)?.priceInfo
          ?.price;
        if (price?.isOk()) {
          sum += price.value.value;
          has = true;
          any = true;
        }
      }
    }
    if (has) byComponent.set(node.recipe.id, sum);
  }
  let total: number | null = null;
  if (any) {
    total = 0;
    for (const v of byComponent.values()) total += v;
  }
  return { byComponent, total };
};
