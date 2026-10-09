import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";

import { totalsLookStuck } from "~/app/recipes/recipe-totals-staleness";
import {
  getServingBasis,
  perUnitSuffix,
} from "~/features/recipes/recipe-utils";
import { recipe as recipeOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { scaleEstimate } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

type RecipeRow = ListRowOf<"recipe">;

/**
 * The cell shown when a recipe's totals are null but it's plausibly stuck: a
 * "Pending" marker plus, on the cost column, a one-click recompute.
 */
function StuckTotalsCell({
  recipe,
  withAction,
}: {
  recipe: RecipeRow;
  withAction: boolean;
}) {
  const recompute = useActionMutation({
    mutationFn: recipeOperations.recomputeOne.mutationOptions,
    success: "Recomputed recipe totals.",
  });
  const notCosted = (
    <span className="text-2xs text-muted-foreground">Pending</span>
  );
  if (!withAction) return notCosted;
  return (
    <Row align="center" gap="xs">
      {notCosted}
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={recompute.isPending}
        title="Recompute this recipe's cost and nutrition"
        onClick={(e) => {
          e.stopPropagation();
          recompute.mutate({ id: recipe.id });
        }}
      >
        <ArrowCounterClockwiseIcon
          className={recompute.isPending ? "animate-spin" : ""}
        />
        Recompute
      </Button>
    </Row>
  );
}

const formatKcal = (value: number) => `${Math.round(value)} kcal`;

/** One estimate column (cost or calories) over the recipe's stored totals. */
const estimateColumn =
  (metric: "cost" | "kcal"): ListRenderer<"recipe"> =>
  (helper) => {
    const getEstimate = (row: RecipeRow) =>
      metric === "cost" ? row.totals?.cost : row.totals?.nutrition.kcal;
    const format = metric === "cost" ? formatCurrency : formatKcal;
    // The primary figure is the server's text; only the per-serving subline
    // below is still derived here.
    const labelKey =
      metric === "cost" ? "costTotalLabel" : "caloriesTotalLabel";
    return createCubbyColumnCollection((add) => {
      add(
        helper.accessor(
          (row) => {
            const estimate = getEstimate(row);
            return estimate && hasKnownEstimate(estimate)
              ? estimate.lower
              : undefined;
          },
          {
            id: metric === "cost" ? "costTotal" : "caloriesTotal",
            header: metric === "cost" ? "Cost" : "Calories",
            meta: {
              numeric: true,
              className: "w-32",
              mobile: {
                slot: "trailing",
                priority: metric === "cost" ? 5 : 10,
              },
            },
            sortUndefined: "last",
            cell: (info) => {
              const recipe = info.row.original;
              const estimate = getEstimate(recipe);
              if (!estimate || estimate.status === "pending")
                return totalsLookStuck(recipe) ? (
                  <StuckTotalsCell
                    recipe={recipe}
                    withAction={metric === "cost"}
                  />
                ) : (
                  <span className="text-muted-foreground">Pending</span>
                );
              const perItem = getServingBasis(recipe);
              return (
                <span className="whitespace-nowrap">
                  <span
                    title={
                      hasKnownEstimate(estimate)
                        ? `${estimate.coverage.covered}/${estimate.coverage.total} ingredient rows covered`
                        : undefined
                    }
                  >
                    {recipe[labelKey]}
                  </span>
                  {perItem && hasKnownEstimate(estimate) && (
                    <span className="ml-1.5 text-2xs text-muted-foreground">
                      {formatEstimate(
                        scaleEstimate(estimate, 1 / perItem.divisor),
                        format,
                      )}{" "}
                      {perUnitSuffix(perItem.noun, { short: true })}
                    </span>
                  )}
                </span>
              );
            },
          },
        ),
      );
    });
  };

export const recipeListRenderers = {
  "estimate-cost": estimateColumn("cost"),
  "estimate-kcal": estimateColumn("kcal"),
} as const;
