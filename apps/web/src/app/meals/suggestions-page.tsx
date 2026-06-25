import type { RecipeAvailability } from "@cubby/schemas/availability";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid, Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { StatusText } from "~/components/ui/status-text";
import { useTRPC } from "~/trpc/react";

/** Filter presets for the minimum-coverage control. */
const FILTERS = [
  { label: "All", minCoverage: 0 },
  { label: "Almost there", minCoverage: 0.5 },
  { label: "Ready", minCoverage: 1 },
] as const;

export function MealSuggestionsPage() {
  const api = useTRPC();
  const [minCoverage, setMinCoverage] = useState(0);

  const { data, isLoading, error } = useQuery(
    api.suggestions.getMakeable.queryOptions({ minCoverage }),
  );

  return (
    <Stack>
      <Row align="center" wrap gap="sm">
        {FILTERS.map((f) => (
          <Button
            key={f.label}
            type="button"
            size="sm"
            variant={minCoverage === f.minCoverage ? "default" : "outline"}
            onClick={() => setMinCoverage(f.minCoverage)}
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
      ) : !data || data.length === 0 ? (
        <Description>
          No recipes match — try lowering the coverage filter.
        </Description>
      ) : (
        <Grid cols="cards3">
          {data.map((recipe) => (
            <RecipeCoverageCard key={recipe.recipeId} recipe={recipe} />
          ))}
        </Grid>
      )}
    </Stack>
  );
}

function RecipeCoverageCard({ recipe }: { recipe: RecipeAvailability }) {
  const ready = recipe.coverage >= 1;
  const pct = Math.round(recipe.coverage * 100);

  return (
    <Link
      to="/recipes/$id"
      params={{ id: recipe.recipeId }}
      className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-4 transition-colors hover:bg-accent"
    >
      <Row align="start" justify="between" gap="sm">
        <span className="font-medium">{recipe.recipeName}</span>
        <Badge variant={ready ? "default" : "secondary"}>
          {ready ? "Ready" : `Missing ${recipe.missing.length}`}
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
    </Link>
  );
}
