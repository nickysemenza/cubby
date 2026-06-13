import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatAmounts } from "~/app/_components/inventory/format-amount";
import { DriftIndicator } from "~/app/_components/parse-drift-indicator";
import { DecompositionView } from "~/app/_components/recipe/decomposition-view";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import type { StaleIngredientParse } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function StaleIngredientParsesList({
  items,
}: {
  items: StaleIngredientParse[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const reparseMutation = useMutation(
    api.problems.reparseStale.mutationOptions({
      onSuccess: (result) => {
        if (result.updated > 0) {
          toast.success(
            `Re-parsed ${result.updated} ingredient line${result.updated !== 1 ? "s" : ""}`,
          );
        } else {
          toast.info("No stale parses to re-parse");
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
      title="Stale Parses"
      description="Ingredient lines whose original text, re-parsed with the current parser, would now differ from what's stored — on name, amounts, or modifier. Re-parsing would update them."
      entity="recipe"
      items={items}
      emptyMessage="No stale parses — every stored ingredient matches a fresh parse of its original line."
      headerAction={
        <Button
          size="sm"
          onClick={() => reparseMutation.mutate()}
          disabled={reparseMutation.isPending}
        >
          {reparseMutation.isPending ? (
            <>
              <Spinner className="mr-2" />
              Re-parsing...
            </>
          ) : (
            "Re-parse All"
          )}
        </Button>
      }
      renderItem={(item) => ({
        // Title is the stable ingredient name; every drifted axis (name included) is a
        // DriftIndicator in the details — the card title is string-typed, so a colored
        // diff can't live there.
        title: item.storedName,
        subtitle: item.recipeName,
        details: [
          <div
            key="drifts"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
          >
            {item.nameDrift && (
              <DriftIndicator
                axis="name"
                before={item.storedName}
                after={item.parsedName}
              />
            )}
            {item.amountDrift && (
              <DriftIndicator
                axis="amount"
                before={formatAmounts(item.storedAmounts)}
                after={formatAmounts(item.parsedAmounts)}
              />
            )}
            {item.modifierDrift && (
              <DriftIndicator
                axis="modifier"
                before={item.storedModifier ?? ""}
                after={item.parsedModifier ?? ""}
              />
            )}
          </div>,
          <div
            key="rawLine"
            className="flex flex-wrap items-baseline gap-x-1 text-muted-foreground/70 text-xs"
            title="How the current parser carves the original line"
          >
            <span className="italic">parsed from:</span>
            <DecompositionView rawLine={item.rawLine} />
          </div>,
        ],
        route: {
          to: "/recipes/$id" as const,
          params: { id: item.recipeId },
        },
      })}
    />
  );
}
