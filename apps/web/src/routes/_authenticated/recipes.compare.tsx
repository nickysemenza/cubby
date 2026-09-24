import { ArrowLeftIcon as ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { useQueries } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { useMemo } from "react";
import { z } from "zod";

import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { useRecipeCostingData } from "~/app/_components/hooks/useRecipeCostingData";
import {
  type ComparedRecipe,
  RecipeCompareGrid,
} from "~/app/_components/recipe/compare/RecipeCompareGrid";
import {
  getEffectiveServings,
  getIngredientName,
} from "~/app/_components/recipe/recipe-utils";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { pageTitle } from "~/lib/page-title";
import { computeRecipeCosting } from "~/lib/recipe-costing";
import { urlStringParam } from "~/lib/search-params";

const searchParamsSchema = z.object({
  ids: urlStringParam,
});

const searchDefaults = { ids: undefined } as const;

export const Route = createFileRoute("/_authenticated/recipes/compare")({
  validateSearch: searchParamsSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: RecipeComparePage,
  head: () => ({ meta: [{ title: pageTitle("Compare recipes") }] }),
});

function RecipeComparePage() {
  const { ids } = Route.useSearch();
  const navigate = useNavigate();

  // Parse recipe IDs from URL
  const recipeIds = useMemo<string[]>(() => {
    const list =
      ids
        ?.split(",")
        .map((id: string) => id.trim())
        .filter((id: string) => id.length > 0) ?? [];
    return uniq(list);
  }, [ids]);

  // Fetch all recipes in parallel
  const recipeQueryOptions = useMemo(
    () => recipeIds.map((id) => entityDetailFor("recipe").queryOptions(id)),
    [recipeIds],
  );

  const { recipes, isLoading } = useQueries({
    queries: recipeQueryOptions,
    combine: (results) => ({
      recipes: results
        .map((q) => q.data)
        .filter((d): d is EntityDetailByEntity["recipe"] => d != null),
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
        estimates: costing?.totals.estimates ?? null,
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

  // Add a recipe to comparison, preserving the current selection.
  const handleAdd = (recipeId: string) => {
    const newIds = uniq([...recipeIds, recipeId]).join(",");
    navigate({ to: "/recipes/compare", search: { ids: newIds } });
  };

  if (recipeIds.length === 0) {
    return (
      <Page variant="list" title="Compare Recipes">
        <Card>
          <CardContent className="py-6 text-center">
            <p className="text-muted-foreground">
              No recipes selected for comparison. Select 2 or more recipes from
              the recipes list.
            </p>
            <Link to="/recipes" className="mt-4 inline-block">
              <Button>
                <ArrowLeft className="mr-2 size-4" />
                Back to Recipes
              </Button>
            </Link>
          </CardContent>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      variant="list"
      title="Compare Recipes"
      layout="full"
      actions={
        <Link to="/recipes">
          <Button variant="outline">
            <ArrowLeft className="mr-2 size-4" />
            Back to Recipes
          </Button>
        </Link>
      }
    >
      {isLoading ? (
        <Card>
          <CardContent className="py-6 text-center">
            <p className="text-muted-foreground">Loading recipes...</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <RecipeCompareGrid compared={compared} onRemove={handleRemove} />

          <div className="mx-auto max-w-sm">
            <WithEntitySearch entity="recipe">
              {({ items, onSearchChange, isLoading, onOpenChange }) => (
                <EntityPicker
                  entity="recipe"
                  label="recipe"
                  items={items}
                  value={null}
                  placeholder="Add another recipe…"
                  onSearchChange={onSearchChange}
                  onOpenChange={onOpenChange}
                  isLoading={isLoading}
                  setValue={(recipe) => {
                    if (!recipe) return;
                    handleAdd(recipe.id);
                  }}
                />
              )}
            </WithEntitySearch>
          </div>
        </div>
      )}
    </Page>
  );
}
