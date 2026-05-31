import type { RecipeAvailability } from "@cubby/schemas/availability";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      {isLoading ? (
        <SimpleLoading text="Checking what you can make..." />
      ) : error ? (
        <p className="text-destructive text-sm">{error.message}</p>
      ) : !data || data.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No recipes match — try lowering the coverage filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((recipe) => (
            <RecipeCoverageCard key={recipe.recipeId} recipe={recipe} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecipeCoverageCard({ recipe }: { recipe: RecipeAvailability }) {
  const ready = recipe.coverage >= 1;
  const pct = Math.round(recipe.coverage * 100);

  return (
    <Link
      to="/recipes/$id"
      params={{ id: recipe.recipeId }}
      className="flex flex-col gap-2 rounded-lg border p-4 transition-colors hover:bg-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{recipe.recipeName}</span>
        <Badge variant={ready ? "default" : "secondary"}>
          {ready ? "Ready" : `Missing ${recipe.missing.length}`}
        </Badge>
      </div>
      <span className="text-muted-foreground text-xs">
        {recipe.availableIngredients}/{recipe.totalIngredients} ingredients
        {recipe.totalIngredients > 0 ? ` · ${pct}%` : ""}
      </span>
      {recipe.missing.length > 0 && (
        <span className="text-muted-foreground text-xs">
          Need: {recipe.missing.join(", ")}
        </span>
      )}
    </Link>
  );
}
