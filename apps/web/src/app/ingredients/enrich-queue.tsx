import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { dedupe } from "~/misc/array-helpers";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { EnrichIngredientDialog } from "../_components/ingredients/enrich-ingredient-dialog";

/**
 * Worklist of stub ingredients (no linked products). Each row opens the shared
 * EnrichIngredientDialog pre-linked to the ingredient, so the user picks a USDA
 * food (which supplies nutrition + conversions at read time) and enters a price.
 */
export function EnrichmentQueue() {
  const api = useTRPC();
  const [selected, setSelected] = useState<IngredientWithFoodOut | null>(null);

  const { data, isLoading, error } = useQuery(
    api.ingredient.list.queryOptions({
      filters: { missingProductsOnly: true },
      pagination: { pageIndex: 0, pageSize: 100 },
    }),
  );

  const items = data?.items ?? [];
  const total = data?.meta.totalCount ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {isLoading
          ? "Loading…"
          : `${total} ingredient${total === 1 ? "" : "s"} need enrichment`}
      </p>

      {error && <div className="text-destructive text-sm">{error.message}</div>}

      {!isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground text-sm">
          Every ingredient has at least one product. Nothing to enrich.
        </div>
      )}

      <ul className="space-y-2">
        {items.map((ingredient) => {
          const recipeCount = dedupe(
            ingredient.appearsInRecipes.map((r) => r.id),
          ).length;
          return (
            <li
              key={ingredient.id}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{ingredient.name}</div>
                <div className="text-muted-foreground text-xs">
                  Appears in {recipeCount} recipe
                  {recipeCount === 1 ? "" : "s"}
                </div>
              </div>
              <Button size="sm" onClick={() => setSelected(ingredient)}>
                Enrich
              </Button>
            </li>
          );
        })}
      </ul>

      <EnrichIngredientDialog
        ingredient={selected ? { id: selected.id, name: selected.name } : null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />

      {isLoading && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}
    </div>
  );
}
