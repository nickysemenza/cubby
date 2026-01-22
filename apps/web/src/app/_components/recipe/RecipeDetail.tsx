import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { useQueries } from "@tanstack/react-query";
import { BarChart3, BookOpen, Newspaper, Table2 } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import {
  type CalculateTotalsResult,
  calculateTotals,
  createIngredientData,
} from "~/app/_components/units/univ-conversion";
import MacroSunburst from "~/app/_components/visualizations/macro-sunburst";
import RecipeCostTreemap from "~/app/_components/visualizations/recipe-cost-treemap";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { formatCurrency } from "~/lib/utils";
import { dedupe } from "~/misc/array-helpers";
import type { RecipeOut, SectionIngredientOut } from "~/schemas/recipe";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { AuditLogList } from "../audit-log/audit-log-list";
import EntityImageList from "../EntityImageList";
import { NYTView } from "./NYTView";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { RecipeTagList } from "./recipe-tag";
import { RecipeIngredientList } from "./recipeingredientlist";
import { getIngredientName } from "./recipeutils";

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
                {recipe.yield!.value} {recipe.yield!.unit}
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

type ViewMode = "magazine" | "nyt" | "table" | "charts";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const api = useTRPC();
  const [viewMode, setViewMode] = useState<ViewMode>("magazine");

  const ingredients: SectionIngredientOut[] = useMemo(
    () => recipe.sections.flatMap((section) => section.ingredients.flat()),
    [recipe.sections],
  );

  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data asynchronously (for table and charts views)
  const ingredientIds = useMemo(() => {
    const ids = ingredients
      .filter((i) => i.type === "ingredient")
      .map((i) => i.ingredient.id);
    return dedupe(ids);
  }, [ingredients]);

  const ingredientQueryOptions = useMemo(
    () =>
      ingredientIds.map((id) => api.ingredient.getByID.queryOptions({ id })),
    [api, ingredientIds],
  );

  const ingredientQueries = useQueries(
    useMemo(
      () => ({ queries: ingredientQueryOptions }),
      [ingredientQueryOptions],
    ),
  );

  const data = useMemo(() => {
    if (ingredientIds.length === 0) return {};
    if (ingredientQueries.some((q) => q.isLoading)) return undefined;
    const ingredientsArray = ingredientQueries
      .map((q) => q.data)
      .filter(Boolean) as IngredientWithFoodOut[];
    if (ingredientsArray.length !== ingredientIds.length) return undefined;
    return ingredientsArray.reduce(
      (acc, ingredient) => {
        acc[ingredient.id] = ingredient;
        return acc;
      },
      {} as Record<string, IngredientWithFoodOut>,
    );
  }, [ingredientIds, ingredientQueries]);

  // Load enriched ingredient data for charts (with price/nutrition info)
  const ingredientDataItems = useMemo(
    () => (data ? createIngredientData(ingredients, data) : []),
    [ingredients, data],
  );

  // Calculate totals for charts
  const totals = useMemo(
    () => (data ? calculateTotals(ingredients, data, getIngredientName) : null),
    [ingredients, data],
  );

  return (
    <div className="space-y-6">
      {/* Tags and View Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {recipe.tags && recipe.tags.length > 0 && (
          <RecipeTagList tags={recipe.tags} />
        )}
        <div className="ml-auto flex gap-2">
          <Button
            variant={viewMode === "magazine" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("magazine")}
          >
            <BookOpen className="mr-2 h-4 w-4" />
            Magazine
          </Button>
          <Button
            variant={viewMode === "nyt" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("nyt")}
          >
            <Newspaper className="mr-2 h-4 w-4" />
            NYT
          </Button>
          <Button
            variant={viewMode === "table" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("table")}
          >
            <Table2 className="mr-2 h-4 w-4" />
            Table
          </Button>
          <Button
            variant={viewMode === "charts" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("charts")}
          >
            <BarChart3 className="mr-2 h-4 w-4" />
            Charts
          </Button>
        </div>
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
          <RecipeIngredientList ingredients={ingredients} ingMap={data} />
        </>
      )}
      {viewMode === "charts" && (
        <div className="space-y-6">
          {/* Yield/Servings Summary */}
          <RecipeSummaryCard recipe={recipe} totals={totals} />

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

export default RecipeDetail;
