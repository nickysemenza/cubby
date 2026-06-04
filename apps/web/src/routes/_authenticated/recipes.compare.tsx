import type { RecipeOut } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { useQueries } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft, Plus, X } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { useRecipeCostingData } from "~/app/_components/hooks/useRecipeCostingData";
import { getIngredientName } from "~/app/_components/recipe/recipe-utils";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  type CalculateTotalsResult,
  calculateTotals,
} from "~/lib/recipe-costing";
import { formatCurrency } from "~/lib/utils";
import { dedupe } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";

const searchParamsSchema = z.object({
  ids: z.string().optional().catch(undefined),
});

const searchDefaults = { ids: undefined } as const;

export const Route = createFileRoute("/_authenticated/recipes/compare")({
  validateSearch: searchParamsSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: RecipeComparePage,
  head: () => ({ meta: [{ title: "Compare Recipes | cubby" }] }),
});

/** Get effective servings: explicit servings, or yield value if unit is "servings" */
function getEffectiveServings(recipe: RecipeOut): number | null {
  if (recipe.servings) return recipe.servings;
  if (recipe.yield?.unit === "servings") return recipe.yield.value;
  return null;
}

interface RecipeWithTotals {
  recipe: RecipeOut;
  totals: CalculateTotalsResult | null;
  effectiveServings: number | null;
}

function RecipeComparePage() {
  const { ids } = Route.useSearch();
  const navigate = useNavigate();
  const api = useTRPC();

  // Parse recipe IDs from URL
  const recipeIds = useMemo<string[]>(() => {
    const list =
      ids
        ?.split(",")
        .map((id: string) => id.trim())
        .filter((id: string) => id.length > 0) ?? [];
    return dedupe(list);
  }, [ids]);

  // Fetch all recipes in parallel
  const recipeQueryOptions = useMemo(
    () => recipeIds.map((id) => api.recipe.getByID.queryOptions({ id })),
    [api, recipeIds],
  );

  const { recipes, isLoading } = useQueries({
    queries: recipeQueryOptions,
    combine: (results) => ({
      recipes: results
        .map((q) => q.data)
        .filter((d): d is RecipeOut => d != null),
      isLoading: results.some((q) => q.isLoading),
    }),
  });

  // Load ingredient data plus any sub-recipe graphs across all compared recipes,
  // so cost/calories roll up correctly. `ingMap` is null until first load.
  const { ingMap, recipeMap } = useRecipeCostingData(recipes);

  // Calculate totals for each recipe
  const recipesWithTotals: RecipeWithTotals[] = useMemo(() => {
    if (!ingMap || recipes.length === 0) return [];

    return recipes.map((recipe) => {
      const ingredients = recipe.sections.flatMap((s) => s.ingredients);
      const totals = calculateTotals(
        ingredients,
        ingMap,
        getIngredientName,
        recipeMap,
      );
      return {
        recipe,
        totals,
        effectiveServings: getEffectiveServings(recipe),
      };
    });
  }, [recipes, ingMap, recipeMap]);

  // Remove a recipe from comparison
  const handleRemove = (recipeId: string) => {
    const newIds = recipeIds.filter((id) => id !== recipeId).join(",");
    if (newIds) {
      navigate({ to: "/recipes/compare", search: { ids: newIds } });
    } else {
      navigate({ to: "/recipes" });
    }
  };

  if (recipeIds.length === 0) {
    return (
      <EntityLayout title="Compare Recipes">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No recipes selected for comparison. Select 2-4 recipes from the
              recipes list.
            </p>
            <Link to="/recipes" className="mt-4 inline-block">
              <Button>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Recipes
              </Button>
            </Link>
          </CardContent>
        </Card>
      </EntityLayout>
    );
  }

  return (
    <EntityLayout
      title="Compare Recipes"
      actions={
        <Link to="/recipes">
          <Button variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Recipes
          </Button>
        </Link>
      }
    >
      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Loading recipes...</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Comparison Table */}
          <Card>
            <CardHeader className="bg-muted/50 px-4 py-3">
              <CardTitle className="font-medium text-base">
                Cost & Nutrition Comparison
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground text-sm">
                        Metric
                      </th>
                      {recipesWithTotals.map(({ recipe }) => (
                        <th
                          key={recipe.id}
                          className="min-w-[150px] px-4 py-3 text-left font-medium text-sm"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Link
                              to="/recipes/$id"
                              params={{ id: recipe.id }}
                              className="hover:underline"
                            >
                              {recipe.name}
                            </Link>
                            <button
                              type="button"
                              onClick={() => handleRemove(recipe.id)}
                              className="text-muted-foreground hover:text-destructive"
                              title="Remove from comparison"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Yield */}
                    <tr className="border-b">
                      <td className="px-4 py-2 text-muted-foreground text-sm">
                        Yield
                      </td>
                      {recipesWithTotals.map(({ recipe }) => (
                        <td key={recipe.id} className="px-4 py-2 text-sm">
                          {recipe.yield
                            ? `${recipe.yield.value} ${recipe.yield.unit}`
                            : "-"}
                        </td>
                      ))}
                    </tr>

                    {/* Servings */}
                    <tr className="border-b">
                      <td className="px-4 py-2 text-muted-foreground text-sm">
                        Servings
                      </td>
                      {recipesWithTotals.map(
                        ({ recipe, effectiveServings }) => (
                          <td key={recipe.id} className="px-4 py-2 text-sm">
                            {effectiveServings ?? "-"}
                          </td>
                        ),
                      )}
                    </tr>

                    {/* Total Cost */}
                    <tr className="border-b">
                      <td className="px-4 py-2 text-muted-foreground text-sm">
                        Total Cost
                      </td>
                      {recipesWithTotals.map(({ recipe, totals }) => (
                        <td key={recipe.id} className="px-4 py-2 text-sm">
                          {totals?.price ? formatCurrency(totals.price) : "-"}
                        </td>
                      ))}
                    </tr>

                    {/* Total Calories */}
                    <tr className="border-b">
                      <td className="px-4 py-2 text-muted-foreground text-sm">
                        Total Calories
                      </td>
                      {recipesWithTotals.map(({ recipe, totals }) => {
                        const calories = totals
                          ? getNutrientValueByKey(totals.nutrients, "kcal")
                          : 0;
                        return (
                          <td key={recipe.id} className="px-4 py-2 text-sm">
                            {calories ? `${Math.round(calories)} kcal` : "-"}
                          </td>
                        );
                      })}
                    </tr>

                    {/* Total Protein */}
                    <tr>
                      <td className="px-4 py-2 text-muted-foreground text-sm">
                        Total Protein
                      </td>
                      {recipesWithTotals.map(({ recipe, totals }) => {
                        const protein = totals
                          ? getNutrientValueByKey(totals.nutrients, "protein")
                          : 0;
                        return (
                          <td key={recipe.id} className="px-4 py-2 text-sm">
                            {protein ? `${Math.round(protein)}g` : "-"}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Add more button (if less than 4) */}
          {recipeIds.length < 4 && (
            <div className="text-center">
              <Link to="/recipes">
                <Button variant="outline">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Another Recipe
                </Button>
              </Link>
            </div>
          )}
        </div>
      )}
    </EntityLayout>
  );
}
