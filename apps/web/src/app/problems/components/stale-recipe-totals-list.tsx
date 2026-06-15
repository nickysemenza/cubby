import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import type { StaleRecipeTotals } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function StaleRecipeTotalsList({
  items,
}: {
  items: StaleRecipeTotals[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const recomputeMutation = useMutation(
    // One batch covers the whole backlog at the max limit; the action is manual
    // (no background loop) so it never busy-polls. USDA-incomplete recipes may
    // stay stale and reappear — that's expected; recompute again once warm.
    api.recipe.recomputeStale.mutationOptions({
      onSuccess: (result) => {
        if (result.processed > 0) {
          toast.success(
            `Recomputed ${result.processed} recipe total${result.processed !== 1 ? "s" : ""}` +
              (result.remaining > 0
                ? ` — ${result.remaining} still awaiting data`
                : ""),
          );
        } else {
          toast.info("No stale totals to recompute");
        }
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({
          queryKey: [api.problems.getAllProblems.queryKey()],
        });
        queryClient.invalidateQueries({
          queryKey: [api.recipe.list.queryKey()],
        });
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
      },
    }),
  );

  return (
    <ProblemSection
      title="Stale Totals"
      description="Recipes whose persisted cost/calorie rollups are out of date — newly added, edited, or affected by a changed price or USDA enrichment. The list shows last-known figures; recomputing refreshes them."
      entity="recipe"
      items={items}
      emptyMessage="No stale totals — every recipe's cost and calorie rollups are up to date."
      headerAction={
        <Button
          size="sm"
          onClick={() => recomputeMutation.mutate({ limit: 500 })}
          disabled={recomputeMutation.isPending}
        >
          {recomputeMutation.isPending ? (
            <>
              <Spinner className="mr-2" />
              Recomputing...
            </>
          ) : (
            "Recompute All"
          )}
        </Button>
      }
      renderItem={(item) => ({
        title: item.recipeName,
        subtitle: item.totals
          ? `${formatCurrencyRange(item.totals.costTotal, item.totals.costTotalUpper)} · ${formatNumberRange(item.totals.caloriesTotal, item.totals.caloriesTotalUpper, (n) => `${Math.round(n)}`)} cal`
          : "Not yet computed",
        route: {
          to: "/recipes/$id" as const,
          params: { id: item.recipeId },
        },
      })}
    />
  );
}
