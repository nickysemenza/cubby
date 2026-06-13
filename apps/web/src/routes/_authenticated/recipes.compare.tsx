import type { RecipeOut } from "@cubby/schemas/recipe";
import { useQueries } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft, Plus } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { useRecipeCostingData } from "~/app/_components/hooks/useRecipeCostingData";
import {
  type ComparedRecipe,
  RecipeCompareGrid,
} from "~/app/_components/recipe/compare/RecipeCompareGrid";
import {
  getEffectiveServings,
  getIngredientName,
  recipeHeadlineTotals,
} from "~/app/_components/recipe/recipe-utils";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { computeRecipeCosting } from "~/lib/recipe-costing";
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

  // One engine call for the whole comparison set (the ingredient payload is
  // deduped across recipes inside the call). The engine classifies flour rows
  // (for baker's percentages) by name internally.
  const compared: ComparedRecipe[] = useMemo(() => {
    if (!ingMap || recipes.length === 0) return [];

    const costings = computeRecipeCosting(
      recipes,
      ingMap,
      getIngredientName,
      recipeMap,
    );
    return recipes.map((recipe) => {
      const costing = costings.get(recipe.id) ?? null;
      return {
        recipe,
        costing,
        headline: costing ? recipeHeadlineTotals(costing.totals) : null,
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
              No recipes selected for comparison. Select 2 or more recipes from
              the recipes list.
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
      fullWidth
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
        <div className="space-y-4">
          <RecipeCompareGrid compared={compared} onRemove={handleRemove} />

          <div className="text-center">
            <Link to="/recipes">
              <Button variant="outline">
                <Plus className="mr-2 h-4 w-4" />
                Add Another Recipe
              </Button>
            </Link>
          </div>
        </div>
      )}
    </EntityLayout>
  );
}
