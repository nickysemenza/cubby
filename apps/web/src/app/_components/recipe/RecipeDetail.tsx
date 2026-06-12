import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { BarChart3, BookOpen, Table2 } from "lucide-react";
import type React from "react";
import { lazy, Suspense, useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { TicketDivider } from "~/components/ui/ticket-divider";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useDebug } from "~/hooks/useDebug";
import { PerfProfiler } from "~/lib/perf/PerfProfiler";
import {
  type CalculateTotalsResult,
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
} from "~/lib/recipe-costing";
import { formatCurrency } from "~/lib/utils";
import { AuditLogList } from "../audit-log/audit-log-list";
import EntityImageList from "../EntityImageList";
import { useRecipeCostingData } from "../hooks/useRecipeCostingData";
import { RecipeMagazineView } from "./RecipeMagazineView";
import {
  type MissingWeightLink,
  RecipeScaleControl,
} from "./RecipeScaleControl";
import { RecipeCostingDebugCard } from "./recipe-costing-debug-card";
import { scaleRecipe } from "./recipe-scaling";
import { RecipeTagList } from "./recipe-tag";
import {
  formatYield,
  getEffectiveServings,
  getIngredientName,
  isFlourIngredient,
} from "./recipe-utils";
import { RecipeIngredientList } from "./recipeingredientlist";

// d3-hierarchy is heavy and only renders in the "charts" view, so keep it out
// of the recipe-detail route chunk until that tab is opened.
const NutritionBars = lazy(
  () => import("~/app/_components/visualizations/nutrition-bars"),
);
const RecipeCostTreemap = lazy(
  () => import("~/app/_components/visualizations/recipe-cost-treemap"),
);

/** Get effective servings: explicit servings, or yield value if unit is "servings" */

/** Summary card showing yield, servings, and per-serving metrics */
const RecipeSummaryCard: React.FC<{
  recipe: RecipeOut;
  totals: CalculateTotalsResult | null;
}> = ({ recipe, totals }) => {
  const effectiveServings = getEffectiveServings(recipe);
  const hasYield = recipe.yield?.value && recipe.yield?.unit;

  // Extract nutrients
  const totalCalories = totals
    ? getNutrientValueByKey(totals.nutrients, "kcal")
    : 0;
  const totalProtein = totals
    ? getNutrientValueByKey(totals.nutrients, "protein")
    : 0;

  // If no yield/servings info, don't show the card
  if (!hasYield && !effectiveServings) return null;

  const perServingCost =
    effectiveServings && totals?.price
      ? totals.price / effectiveServings
      : null;
  const perServingCalories =
    effectiveServings && totalCalories
      ? totalCalories / effectiveServings
      : null;
  const perServingProtein =
    effectiveServings && totalProtein ? totalProtein / effectiveServings : null;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex flex-wrap gap-6">
          {/* Yield info */}
          {hasYield && (
            <div>
              <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                Makes
              </div>
              <div className="font-mono font-semibold text-lg tabular-nums">
                {formatYield(recipe.yield!)}
              </div>
            </div>
          )}

          {/* Servings (only if different from yield) */}
          {effectiveServings && recipe.yield?.unit !== "servings" && (
            <div>
              <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                Servings
              </div>
              <div className="font-mono font-semibold text-lg tabular-nums">
                {effectiveServings}
              </div>
            </div>
          )}

          {/* Total cost */}
          {totals?.price ? (
            <div>
              <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                Total Cost
              </div>
              <div className="font-mono font-semibold text-lg tabular-nums">
                {formatCurrency(totals.price)}
              </div>
            </div>
          ) : null}

          {/* Per-serving metrics */}
          {perServingCost && (
            <div>
              <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                Cost per Serving
              </div>
              <div className="font-mono font-semibold text-lg tabular-nums">
                {formatCurrency(perServingCost)}
              </div>
            </div>
          )}
          {perServingCalories && (
            <div>
              <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                Calories per Serving
              </div>
              <div className="font-mono font-semibold text-lg tabular-nums">
                {Math.round(perServingCalories)} kcal
              </div>
            </div>
          )}
          {perServingProtein && (
            <div>
              <div className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
                Protein per Serving
              </div>
              <div className="font-mono font-semibold text-lg tabular-nums">
                {Math.round(perServingProtein)}g
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export type RecipeViewMode = "magazine" | "table" | "charts";

export const RECIPE_VIEW_OPTIONS: ViewSwitcherOption<RecipeViewMode>[] = [
  { value: "magazine", label: "Magazine", icon: BookOpen },
  { value: "table", label: "Table", icon: Table2 },
  { value: "charts", label: "Charts", icon: BarChart3 },
];

const RecipeDetailInner: React.FC<{
  recipe: RecipeOut;
  /** Controlled view mode (e.g. URL-driven on the detail route). */
  view?: RecipeViewMode;
  onViewChange?: (view: RecipeViewMode) => void;
  /** Controlled scale factor (URL-driven on the detail route); 1 = unscaled. */
  scale?: number;
  onScaleChange?: (factor: number) => void;
}> = ({
  recipe,
  view: controlledView,
  onViewChange,
  scale: controlledScale,
  onScaleChange,
}) => {
  // Controlled when the parent supplies view/onViewChange; otherwise self-managed
  // (e.g. the search preview panel embeds this without URL state).
  const [internalView, setInternalView] = useState<RecipeViewMode>("magazine");
  const [internalScale, setInternalScale] = useState(1);
  const { isDebugEnabled } = useDebug();
  const viewMode = controlledView ?? internalView;
  const setViewMode = onViewChange ?? setInternalView;
  const factor = controlledScale ?? internalScale;
  const setFactor = onScaleChange ?? setInternalScale;

  // Derived scaled recipe: every amount (plus yield/servings) multiplied by the
  // factor. All downstream views + the costing engine consume this, so scaling
  // is a single transform upstream of the TS→WASM boundary. IDs are preserved.
  const scaledRecipe = useMemo(
    () => scaleRecipe(recipe, factor),
    [recipe, factor],
  );

  const ingredients: CostingRow[] = useMemo(
    () => flattenSections(scaledRecipe.sections),
    [scaledRecipe.sections],
  );

  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data plus the graph of any sub-recipes used as ingredients,
  // so cost/calories roll up correctly (table and charts views). `ingMap` is
  // null until the first load completes. Keyed by ids (scaling doesn't change
  // them), so use the original recipe here to avoid refetch churn on scale.
  const recipesForData = useMemo(() => [recipe], [recipe]);
  const recipesForCosting = useMemo(() => [scaledRecipe], [scaledRecipe]);
  const { ingMap, recipeMap } = useRecipeCostingData(recipesForData);

  // One engine call (Rust, via cost_recipes) per data change: totals + per-row
  // resolved measures — the usage-estimate overrides (absorbed frying oil,
  // to-taste salt, …) already applied — plus "est." markers and baker
  // percentages. The table and charts views share this result so they always
  // agree with the summary totals.
  const costing = useMemo(
    () =>
      ingMap
        ? (computeRecipeCosting(
            recipesForCosting,
            ingMap,
            getIngredientName,
            recipeMap,
            { isFlour: isFlourIngredient },
          ).get(recipe.id) ?? null)
        : null,
    [recipesForCosting, ingMap, recipeMap, recipe.id],
  );
  const totals = costing?.totals ?? null;
  const ingredientDataItems = costing?.rows ?? [];

  // Ingredients whose line can't reach grams (so the total-weight scale anchor
  // can't use them) → deep-link to where the mapping is added. Keyed off the
  // engine's per-row gram Result (`priceInfo.gram.isErr()`), NOT the name-string
  // `totals.missingByType.weight`, so identity stays exact (ids, not names).
  const missingWeightLinks = useMemo<MissingWeightLink[]>(() => {
    if (!costing || !ingMap) return [];
    const seen = new Set<string>();
    const out: MissingWeightLink[] = [];
    for (const row of costing.rows) {
      if (row.type !== "ingredient") continue; // sub-recipe rows: different problem
      if (!row.priceInfo || row.priceInfo.gram.isOk()) continue; // reaches grams → fine
      const id = row.ingredient.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const products = ingMap[id]?.product ?? [];
      out.push({
        ingredientId: id,
        name: row.ingredient.name,
        productId: products.length === 1 ? products[0].id : null,
      });
    }
    return out;
  }, [costing, ingMap]);

  return (
    <div className="space-y-6">
      {/* Tags, Scale control, and View Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        {recipe.tags && recipe.tags.length > 0 && (
          <RecipeTagList tags={recipe.tags} />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <RecipeScaleControl
            recipe={recipe}
            totals={totals}
            missingWeightLinks={missingWeightLinks}
            factor={factor}
            onFactorChange={setFactor}
          />
          <ViewSwitcher
            ariaLabel="Recipe view"
            options={RECIPE_VIEW_OPTIONS}
            value={viewMode}
            onValueChange={setViewMode}
          />
        </div>
      </div>

      {/* View Components */}
      {viewMode === "magazine" && (
        <RecipeMagazineView
          recipe={scaledRecipe}
          totals={totals}
          costing={costing}
        />
      )}
      {viewMode === "table" && (
        <>
          {/* Images for table view */}
          {recipeImages.length > 0 && (
            <div className="mb-2">
              <EntityImageList images={recipeImages} />
            </div>
          )}
          <RecipeIngredientList
            ingredients={ingredients}
            ingMap={ingMap ?? undefined}
            costing={costing}
          />
        </>
      )}
      {viewMode === "charts" && (
        <div className="space-y-6">
          {/* Yield/Servings Summary */}
          <RecipeSummaryCard recipe={scaledRecipe} totals={totals} />

          <Suspense
            fallback={
              <div className="h-[300px]">
                <SimpleLoading />
              </div>
            }
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Cost Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  {ingredientDataItems.length > 0 ? (
                    <RecipeCostTreemap
                      ingredients={ingredientDataItems}
                      totalCost={totals?.price ?? 0}
                    />
                  ) : (
                    <div className="h-[300px]">
                      <SimpleLoading />
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Nutrition Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  {ingredientDataItems.length > 0 ? (
                    <NutritionBars ingredients={ingredientDataItems} />
                  ) : (
                    <div className="h-[300px]">
                      <SimpleLoading />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </Suspense>
        </div>
      )}

      {/* Additional Images (for magazine view, if more than hero) */}
      {viewMode === "magazine" && recipeImages.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>More Images</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* Debug mode: how the totals were produced (usage, rules, errors, paths) */}
      {isDebugEnabled && (
        <RecipeCostingDebugCard recipeId={unsafeRecipeId(recipe.id)} />
      )}

      {/* Tear line between the recipe itself and its paper trail */}
      <TicketDivider className="print:hidden" />

      {/* History Section */}
      <Card className="print:hidden">
        <CardHeader className="pb-2">
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="p-3">
          <AuditLogList
            entityType="recipe"
            entityId={recipe.id}
            showEntityLink={false}
          />
        </CardContent>
      </Card>
    </div>
  );
};

// Profiled boundary so the perf overlay can attribute the recipe-detail render
// churn (the query-streaming re-render storm) to this subtree by name.
const RecipeDetail: React.FC<React.ComponentProps<typeof RecipeDetailInner>> = (
  props,
) => (
  // biome-ignore lint/correctness/useUniqueElementIds: React <Profiler> id, not a DOM id
  <PerfProfiler id="RecipeDetail">
    <RecipeDetailInner {...props} />
  </PerfProfiler>
);

export default RecipeDetail;
