import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
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
import { PerfProfiler } from "~/lib/perf/PerfProfiler";
import {
  type CalculateTotalsResult,
  calculateTotals,
  createIngredientData,
} from "~/lib/recipe-costing";
import { formatCurrency } from "~/lib/utils";
import { AuditLogList } from "../audit-log/audit-log-list";
import EntityImageList from "../EntityImageList";
import { useRecipeCostingData } from "../hooks/useRecipeCostingData";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { RecipeTagList } from "./recipe-tag";
import {
  formatYield,
  getEffectiveServings,
  getIngredientName,
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
}> = ({ recipe, view: controlledView, onViewChange }) => {
  // Controlled when the parent supplies view/onViewChange; otherwise self-managed
  // (e.g. the search preview panel embeds this without URL state).
  const [internalView, setInternalView] = useState<RecipeViewMode>("magazine");
  const viewMode = controlledView ?? internalView;
  const setViewMode = onViewChange ?? setInternalView;

  const ingredients: SectionIngredientOut[] = useMemo(
    () => recipe.sections.flatMap((section) => section.ingredients.flat()),
    [recipe.sections],
  );

  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data plus the graph of any sub-recipes used as ingredients,
  // so cost/calories roll up correctly (table and charts views). `ingMap` is
  // null until the first load completes.
  const recipesForCosting = useMemo(() => [recipe], [recipe]);
  const { ingMap, recipeMap } = useRecipeCostingData(recipesForCosting);

  // Load enriched ingredient data for charts (with price/nutrition info)
  const ingredientDataItems = useMemo(
    () => (ingMap ? createIngredientData(ingredients, ingMap, recipeMap) : []),
    [ingredients, ingMap, recipeMap],
  );

  // Calculate totals for charts
  const totals = useMemo(
    () =>
      ingMap
        ? calculateTotals(ingredients, ingMap, getIngredientName, recipeMap)
        : null,
    [ingredients, ingMap, recipeMap],
  );

  return (
    <div className="space-y-6">
      {/* Tags and View Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {recipe.tags && recipe.tags.length > 0 && (
          <RecipeTagList tags={recipe.tags} />
        )}
        <ViewSwitcher
          className="ml-auto"
          ariaLabel="Recipe view"
          options={RECIPE_VIEW_OPTIONS}
          value={viewMode}
          onValueChange={setViewMode}
        />
      </div>

      {/* View Components */}
      {viewMode === "magazine" && (
        <RecipeMagazineView recipe={recipe} totals={totals} />
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
            recipeMap={recipeMap}
          />
        </>
      )}
      {viewMode === "charts" && (
        <div className="space-y-6">
          {/* Yield/Servings Summary */}
          <RecipeSummaryCard recipe={recipe} totals={totals} />

          <Suspense
            fallback={
              <div className="h-[300px]">
                <SimpleLoading />
              </div>
            }
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader className="bg-muted/50 px-4 py-2">
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
                <CardHeader className="bg-muted/50 px-4 py-2">
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
          <CardHeader className="bg-muted/50 px-4 py-2">
            <CardTitle>More Images</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* Tear line between the recipe itself and its paper trail */}
      <TicketDivider />

      {/* History Section */}
      <Card>
        <CardHeader className="bg-muted/50 px-4 py-2">
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
