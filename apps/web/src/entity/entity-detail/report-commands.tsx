import type {
  CommitPreparedRequest,
  ReportCommand,
  ReportCommandRequest,
} from "@cubby/schemas/entity-report";
import {
  type ChoiceAnswers,
  commitPreparedInput,
} from "@cubby/schemas/report-choice";
import { match } from "ts-pattern";

import { runHref } from "~/app/purchases/purchase-import-links";
import {
  meal,
  problems,
  recipe,
  run,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Button } from "~/ui/primitives/button";

/** Runs a row command through the operation it names; the server composed the exact body. */
export function useReportCommands() {
  const control = useActionMutation({
    mutationFn: run.control.mutationOptions,
    error: "Could not update the Run",
    onSuccess: ({ successor }) => {
      if (successor) window.location.assign(runHref(successor.publicId));
    },
  });
  const finding = useActionMutation({
    mutationFn: problems.resolveRunFinding.mutationOptions,
    error: "Could not resolve the finding",
    success: (result) =>
      result.status === "applied"
        ? "Applied import correction"
        : "Dismissed import finding",
  });
  const retry = useActionMutation({
    mutationFn: run.retryGmailSearch.mutationOptions,
    error: "Could not resend Gmail work",
  });
  const reprocess = useActionMutation({
    mutationFn: recipe.reprocessCookbookOnce.mutationOptions,
    error: "Could not reprocess the cookbook",
    success: (result) => `Reprocessed ${result.reprocessed} recipes`,
  });
  const importRecipes = useActionMutation({
    mutationFn: recipe.importCookbookRecipesOnce.mutationOptions,
    error: "Could not add the recipes",
    success: (result) =>
      result.failed > 0
        ? `Added ${result.succeeded}; ${result.failed} failed`
        : `Added ${result.succeeded} recipes`,
  });
  const mealRecipe = useActionMutation({
    mutationFn: meal.updateRecipe.mutationOptions,
    error: "Could not change the meal",
  });
  const mealAdd = useActionMutation({
    mutationFn: meal.addRecipe.mutationOptions,
    error: "Could not add the recipe",
  });
  const mealRemove = useActionMutation({
    mutationFn: meal.removeRecipe.mutationOptions,
    error: "Could not remove the recipe",
  });
  const mealPrepare = useActionMutation({
    mutationFn: meal.savePreparation.mutationOptions,
    error: "Could not save the portions",
  });
  const flow = useActionMutation({
    mutationFn: recipe.generateFlow.mutationOptions,
    error: "Could not generate the walkthrough",
    success: "Walkthrough generated",
  });
  const reparse = useActionMutation({
    mutationFn: recipe.reparseLine.mutationOptions,
    error: "Re-parse failed",
    success: (result) =>
      result.status === "updated"
        ? `Re-parsed the line (${result.changed.join(", ")})`
        : "Nothing to update from a fresh parse.",
  });
  const commit = useActionMutation({
    mutationFn: run.commitPrepared.mutationOptions,
    error: "Could not import the prepared orders",
  });
  return {
    pending:
      control.isPending ||
      finding.isPending ||
      retry.isPending ||
      reparse.isPending ||
      flow.isPending ||
      reprocess.isPending ||
      importRecipes.isPending ||
      mealRecipe.isPending ||
      mealAdd.isPending ||
      mealRemove.isPending ||
      mealPrepare.isPending ||
      commit.isPending,
    committed: commit.isSuccess,
    /** Approves a prepared batch with the answers given; nothing is sent while any is missing. */
    commit: (
      request: CommitPreparedRequest,
      answers: ChoiceAnswers,
      operationId: string,
    ) => {
      const input = commitPreparedInput(request, answers, operationId);
      if (input) commit.mutate(input);
    },
    run: (request: ReportCommandRequest) =>
      match(request)
        .with({ kind: "run-control" }, (r) => {
          const input: Parameters<typeof run.control.call>[0] = {
            runId: r.runId,
            action: r.action,
          };
          if (r.operationId) input.operationId = r.operationId;
          if (r.approvalId) input.approvalId = r.approvalId;
          control.mutate(input);
        })
        .with({ kind: "resolve-finding" }, (r) => {
          const input: Parameters<typeof problems.resolveRunFinding.call>[0] = {
            id: r.findingId,
            action: r.decision,
          };
          if (r.reviewedFingerprint)
            input.reviewedFingerprint = r.reviewedFingerprint;
          finding.mutate(input);
        })
        .with({ kind: "retry-gmail-search" }, (r) =>
          retry.mutate({ shortcode: r.runId }),
        )
        .with({ kind: "reprocess-cookbook" }, (r) =>
          reprocess.mutate({ cookbookId: r.cookbookId }),
        )
        .with({ kind: "import-cookbook-recipes" }, (r) =>
          importRecipes.mutate({
            cookbookId: r.cookbookId,
            recipeIds: r.recipeIds,
          }),
        )
        // The meal commands ask the person for a scale, recipe, eater or amount first; web has
        // its own dialogs for those and never renders these reports, so a request that still
        // lacks its input is not sent.
        .with({ kind: "meal-add-recipe" }, (r) => {
          if (r.recipeId !== null && r.scale !== null)
            mealAdd.mutate({
              mealId: r.mealId,
              recipeId: r.recipeId,
              scale: r.scale,
            });
        })
        .with({ kind: "meal-scale-recipe" }, (r) => {
          if (r.scale !== null)
            mealRecipe.mutate({ id: r.mealRecipeId, scale: r.scale });
        })
        .with({ kind: "meal-remove-recipe" }, (r) =>
          mealRemove.mutate({ id: r.mealRecipeId }),
        )
        .with({ kind: "meal-portion-set" }, (r) => {
          if (r.ledgerPartyId !== null && r.value !== null && r.unit !== null)
            mealPrepare.mutate({
              mealRecipeId: r.mealRecipeId,
              changes: [
                {
                  action: "set",
                  mealId: r.mealId,
                  ledgerPartyId: r.ledgerPartyId,
                  amount: { value: r.value, unit: r.unit },
                  confirmed: r.confirmed,
                },
              ],
            });
        })
        .with({ kind: "meal-portion-remove" }, (r) =>
          mealPrepare.mutate({
            mealRecipeId: r.mealRecipeId,
            changes: [
              {
                action: "remove",
                mealId: r.mealId,
                ledgerPartyId: r.ledgerPartyId,
              },
            ],
          }),
        )
        .with({ kind: "meal-yield" }, (r) => {
          if (r.grams !== null)
            mealPrepare.mutate({
              mealRecipeId: r.mealRecipeId,
              ...(r.field === "actual"
                ? { actualYieldGrams: r.grams }
                : { estimatedYieldGrams: r.grams }),
              changes: [],
            });
        })
        .with({ kind: "generate-recipe-flow" }, (r) =>
          flow.mutate({ id: r.recipeId, force: r.force }),
        )
        .with({ kind: "reparse-line" }, (r) =>
          reparse.mutate({ recipeId: r.recipeId, lineId: r.lineId }),
        )
        .exhaustive(),
  };
}

export type ReportCommands = ReturnType<typeof useReportCommands>;

/**
 * A row command. Web acts on the tap, as these controls always have (the Run page's Approve,
 * Reject and Apply fix buttons never asked first); the `confirm` copy is for native, which asks
 * before anything that writes.
 */
export function CommandButton({
  command,
  commands,
}: {
  command: ReportCommand;
  commands: ReportCommands;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={command.prominent ? "default" : "outline"}
      disabled={commands.pending}
      onClick={() => commands.run(command.request)}
    >
      {command.label}
    </Button>
  );
}
