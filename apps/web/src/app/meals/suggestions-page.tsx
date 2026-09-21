import type { RecipeAvailability } from "@cubby/schemas/availability";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { suggestions } from "~/app/recipes/recipe.functions";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid, Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { StatusText } from "~/components/ui/status-text";
import { entityDetailLink } from "~/entities/entities";

import { AddToMeal } from "./add-to-meal";
import {
  type MealSuggestionFilter,
  mealSuggestionFilters,
} from "./meal-search";

interface MealSuggestionsPageProps {
  filter: MealSuggestionFilter;
  onFilterChange: (filter: MealSuggestionFilter) => void;
}

export function MealSuggestionsPage({
  filter,
  onFilterChange,
}: MealSuggestionsPageProps) {
  const activeFilter =
    mealSuggestionFilters.find((f) => f.value === filter) ??
    mealSuggestionFilters[0];
  const minCoverage = activeFilter.minCoverage;

  const { data, isLoading, error } = useQuery(
    suggestions.getMakeable.queryOptions({ minCoverage }),
  );

  return (
    <Stack>
      <Row align="center" wrap gap="sm">
        {mealSuggestionFilters.map((f) => (
          <Button
            key={f.label}
            type="button"
            size="sm"
            variant={activeFilter.value === f.value ? "default" : "outline"}
            onClick={() => onFilterChange(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </Row>

      {isLoading ? (
        <SimpleLoading text="Checking what you can make..." />
      ) : error ? (
        <StatusText tone="destructive" className="text-sm">
          {error.message}
        </StatusText>
      ) : !data || data.recipes.length === 0 ? (
        <Description>
          No recipes match — try lowering the coverage filter.
        </Description>
      ) : (
        <>
          <Grid cols="cards3">
            {data.recipes.map((recipe) => (
              <RecipeCoverageCard key={recipe.recipeId} recipe={recipe} />
            ))}
          </Grid>
          {data.truncated && (
            <Description size="xs">
              Only the first {data.candidateCap} recipes were considered.
            </Description>
          )}
        </>
      )}
    </Stack>
  );
}

function RecipeCoverageCard({ recipe }: { recipe: RecipeAvailability }) {
  const assumedNames = [
    ...new Set(
      recipe.ingredients
        .filter((row) => row.availabilitySource === "assumed")
        .map((row) => row.name),
    ),
  ];
  const hasIncompleteInformation =
    recipe.unexpandedSubRecipes > 0 ||
    recipe.ingredients.some((row) => row.quantityIssues.length > 0);
  const ready = recipe.coverage >= 1 && !hasIncompleteInformation;
  const pct = Math.round(recipe.coverage * 100);

  // The card body is the recipe link; the footer holds "Add to meal" as a
  // sibling so planning doesn't hijack card navigation.
  return (
    <Stack
      gap="sm"
      className="border border-[var(--border)] p-4 transition-colors hover:bg-accent"
    >
      <Link
        {...entityDetailLink("recipe", recipe.recipeId)}
        className="flex flex-col gap-2"
      >
        <Row align="start" justify="between" gap="sm">
          <span className="font-medium">{recipe.recipeName}</span>
          <Badge variant={ready ? "default" : "secondary"}>
            {ready
              ? "Ready"
              : recipe.missing.length > 0
                ? `Missing ${recipe.missing.length}`
                : "Review recipe"}
          </Badge>
        </Row>
        <Description as="span" size="xs">
          {recipe.availableIngredients}/{recipe.totalIngredients} ingredients
          {recipe.totalIngredients > 0 ? ` · ${pct}%` : ""}
        </Description>
        {recipe.missing.length > 0 && (
          <Description as="span" size="xs">
            Need: {recipe.missing.join(", ")}
          </Description>
        )}
        {assumedNames.length > 0 && (
          <Description as="span" size="xs">
            Staples assumed: {assumedNames.join(", ")}
          </Description>
        )}
        {hasIncompleteInformation && (
          <Description as="span" size="xs" className="text-warning-ink">
            Recipe information needs review.
          </Description>
        )}
      </Link>
      <Row justify="end">
        <AddToMeal recipeId={recipe.recipeId} recipeName={recipe.recipeName} />
      </Row>
    </Stack>
  );
}
