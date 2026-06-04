import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { BarChart3, BookOpen, Newspaper, Table2 } from "lucide-react";
import type React from "react";
import { lazy, Suspense, useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
import { NYTView } from "./NYTView";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { RecipeTagList } from "./recipe-tag";
import { formatYield, getIngredientName } from "./recipe-utils";
import { RecipeIngredientList } from "./recipeingredientlist";

// Nivo + d3-hierarchy are heavy and only render in the "charts" view, so keep
// them out of the recipe-detail route chunk until that tab is opened.
const MacroSunburst = lazy(
  () => import("~/app/_components/visualizations/macro-sunburst"),
);
const RecipeCostTreemap = lazy(
  () => import("~/app/_components/visualizations/recipe-cost-treemap"),
);

/** Get effective servings: explicit servings, or yield value if unit is "servings" */
function getEffectiveServings(recipe: RecipeOut): number | null {
  if (recipe.servings) return recipe.servings;
  if (recipe.yield?.unit === "servings") return recipe.yield.value;
  return null;
}

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
      <CardContent className="p-4">
        <div className="flex flex-wrap gap-6">
          {/* Yield info */}
          {hasYield && (
            <div>
              <div className="text-muted-foreground text-sm">Makes</div>
              <div className="font-medium text-lg">
                {formatYield(recipe.yield!)}
              </div>
            </div>
          )}

          {/* Servings (only if different from yield) */}
          {effectiveServings && recipe.yield?.unit !== "servings" && (
            <div>
              <div className="text-muted-foreground text-sm">Servings</div>
              <div className="font-medium text-lg">{effectiveServings}</div>
            </div>
          )}

          {/* Total cost */}
          {totals?.price ? (
            <div>
              <div className="text-muted-foreground text-sm">Total Cost</div>
              <div className="font-medium text-lg">
                {formatCurrency(totals.price)}
              </div>
            </div>
          ) : null}

          {/* Per-serving metrics */}
          {perServingCost && (
            <div>
              <div className="text-muted-foreground text-sm">
                Cost per Serving
              </div>
              <div className="font-medium text-lg">
                {formatCurrency(perServingCost)}
              </div>
            </div>
          )}
          {perServingCalories && (
            <div>
              <div className="text-muted-foreground text-sm">
                Calories per Serving
              </div>
              <div className="font-medium text-lg">
                {Math.round(perServingCalories)} kcal
              </div>
            </div>
          )}
          {perServingProtein && (
            <div>
              <div className="text-muted-foreground text-sm">
                Protein per Serving
              </div>
              <div className="font-medium text-lg">
                {Math.round(perServingProtein)}g
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export type RecipeViewMode = "magazine" | "nyt" | "table" | "charts";

export const RECIPE_VIEW_OPTIONS: ViewSwitcherOption<RecipeViewMode>[] = [
  { value: "magazine", label: "Magazine", icon: BookOpen },
  { value: "nyt", label: "NYT", icon: Newspaper },
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
      <div className="flex flex-wrap items-center justify-between gap-4">
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
      {viewMode === "magazine" && <RecipeMagazineView recipe={recipe} />}
      {viewMode === "nyt" && <NYTView recipe={recipe} />}
      {viewMode === "table" && (
        <>
          {/* Images for table view */}
          {recipeImages.length > 0 && (
            <div className="mb-6">
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
                <CardHeader className="bg-muted/50 px-4 py-3">
                  <CardTitle className="font-medium text-base">
                    Cost Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
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
                <CardHeader className="bg-muted/50 px-4 py-3">
                  <CardTitle className="font-medium text-base">
                    Nutrition Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  {ingredientDataItems.length > 0 ? (
                    <MacroSunburst ingredients={ingredientDataItems} />
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
          <CardHeader className="bg-muted/50 px-4 py-3">
            <CardTitle className="font-medium text-base">More Images</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* History Section */}
      <Card>
        <CardHeader className="bg-muted/50 px-4 py-3">
          <CardTitle className="font-medium text-base">History</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
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
