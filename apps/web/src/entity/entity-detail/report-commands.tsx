import type {
  CommitPreparedRequest,
  ReportCommand,
  ReportCommandRequest,
  ReportCommandInput,
} from "@cubby/schemas/entity-report";
import { reportCommandRequest } from "@cubby/schemas/entity-report";
import {
  type ChoiceAnswers,
  commitPreparedInput,
} from "@cubby/schemas/report-choice";
import { useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { z } from "zod";

import { runHref } from "~/app/purchases/purchase-import-links";
import { reclassifySummary } from "~/entity/actions/email-entity-actions";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  meal,
  purchaseImport,
  problems,
  recipe,
  run,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { cn } from "~/lib/utils";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { EntityPicker } from "~/ui/combobox/entity-picker";
import {
  isReferencePickerEntity,
  requireReferenceEntitySearch,
} from "~/ui/combobox/reference-entity-search";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { NativeSelect } from "~/ui/primitives/native-select";
import { ChoiceSwitcher } from "~/ui/primitives/view-switcher";

const sameSelection = (
  sent: readonly { id: string; expectedChecksum: string }[] | undefined,
  shown: readonly { id: string; expectedChecksum: string }[],
) =>
  sent !== undefined &&
  sent.length === shown.length &&
  sent.every(
    (item, index) =>
      item.id === shown[index]?.id &&
      item.expectedChecksum === shown[index]?.expectedChecksum,
  );

/** Runs a row command through the operation it names; the server composed the exact body. */
export function useReportCommands() {
  const emailDecision = useActionMutation({
    mutationFn: purchaseImport.emailPurchaseDecide.mutationOptions,
    error: "Could not update the Email's Purchase link",
    success: ({ purchaseId, state }) =>
      state === "linked"
        ? `Linked to ${purchaseId}`
        : `Dismissed for ${purchaseId}`,
  });
  const emailAccuracy = useActionMutation({
    mutationFn: purchaseImport.emailAccuracyCreate.mutationOptions,
    error: "Could not create the independent review sample",
    success: ({ sampleSize }) =>
      `Independent review sample: ${sampleSize} Emails`,
  });
  const emailImport = useActionMutation({
    mutationFn: purchaseImport.emailImport.mutationOptions,
    error: "Could not import this Email",
    success: ({ runIds }) => `Import Runs: ${runIds.join(", ")}`,
  });
  const emailReclassify = useActionMutation({
    mutationFn: purchaseImport.emailReclassify.mutationOptions,
    error: "Could not reclassify this Email",
    success: reclassifySummary,
  });
  const emailPreview = useActionMutation({
    mutationFn: purchaseImport.emailPreviewRerun.mutationOptions,
    error: "Could not rerun the extraction preview",
    success: ({ runId, status }) => `Extraction preview: ${status} (${runId})`,
  });
  const relevance = useActionMutation({
    mutationFn: purchaseImport.correctEmailRelevance.mutationOptions,
    error: "Could not correct the Relevance",
    success: "Relevance corrected",
  });
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
  const reprocess = useActionMutation({
    mutationFn: recipe.reprocessCookbookOnce.mutationOptions,
    error: "Could not reprocess the cookbook",
  });
  const importRecipes = useActionMutation({
    mutationFn: recipe.importCookbookRecipesOnce.mutationOptions,
    error: "Could not add the recipes",
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
    runsFor: (request: ReportCommandRequest): readonly string[] =>
      match(request)
        .with({ kind: "import-email" }, (r) =>
          sameSelection(emailImport.variables?.items, r.items)
            ? (emailImport.data?.runIds ?? [])
            : [],
        )
        .with({ kind: "reclassify-email" }, (r) =>
          emailReclassify.variables?.ids.join() === r.ids.join()
            ? (emailReclassify.data?.runIds ?? [])
            : [],
        )
        .with({ kind: "rerun-email-preview" }, (r) =>
          emailPreview.data &&
          emailPreview.variables?.id === r.id &&
          emailPreview.variables.expectedChecksum === r.expectedChecksum
            ? [emailPreview.data.runId]
            : [],
        )
        .otherwise(() => []),
    pending:
      emailDecision.isPending ||
      emailImport.isPending ||
      emailReclassify.isPending ||
      emailPreview.isPending ||
      relevance.isPending ||
      emailAccuracy.isPending ||
      control.isPending ||
      finding.isPending ||
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
        .with({ kind: "create-email-accuracy" }, (r) =>
          emailAccuracy.mutate({ sampleSize: r.sampleSize }),
        )
        .with({ kind: "import-email" }, (r) =>
          emailImport.mutate({ items: r.items }),
        )
        .with({ kind: "reclassify-email" }, (r) =>
          emailReclassify.mutate({ ids: r.ids }),
        )
        .with({ kind: "rerun-email-preview" }, (r) =>
          emailPreview.mutate({
            id: r.id,
            expectedChecksum: r.expectedChecksum,
          }),
        )
        .with({ kind: "correct-email-relevance" }, (r) =>
          relevance.mutate({
            id: r.id,
            expectedChecksum: r.expectedChecksum,
            reviewedChecksum: r.reviewedChecksum,
            classification: r.classification,
            reason: r.reason,
          }),
        )
        .with({ kind: "decide-email-purchase" }, (r) =>
          emailDecision.mutate({
            id: r.id,
            expectedChecksum: r.expectedChecksum,
            purchaseId: r.purchaseId,
            decision: r.decision,
          }),
        )
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
        // Bounded calls, one window at a time; the first error stops the loop (the hook has
        // already shown it).
        .with({ kind: "reprocess-cookbook" }, async (r) => {
          let offset: number | null = 0;
          let total = 0;
          try {
            while (offset !== null) {
              const done = await reprocess.mutateAsync({
                cookbookId: r.cookbookId,
                offset,
              });
              total += done.reprocessed;
              offset = done.nextOffset;
            }
          } catch {
            // SILENT: useActionMutation already showed the error; the loop just stops.
            return;
          }
          toast.success(`Reprocessed ${total} recipes`);
        })
        .with({ kind: "import-cookbook-recipes" }, async (r) => {
          let imported = 0;
          try {
            for (let i = 0; i < r.recipeIds.length; i += r.chunkSize) {
              const done = await importRecipes.mutateAsync({
                cookbookId: r.cookbookId,
                recipeIds: r.recipeIds.slice(i, i + r.chunkSize),
              });
              imported += done.imported;
              if (done.failed > 0) {
                toast.error(
                  `Added ${imported}; ${done.failed} failed: ${done.failures.map((failure) => `${failure.sourceRecipeId}: ${failure.error}`).join("; ")}`,
                );
                return;
              }
            }
          } catch {
            // SILENT: useActionMutation already showed the error; the loop just stops.
            return;
          }
          toast.success(`Added ${imported} recipes`);
        })
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
  compact = false,
}: {
  command: ReportCommand;
  commands: ReportCommands;
  /** One inline line: inputs carry their label as their accessible name, not a stacked caption. */
  compact?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | number>>(() =>
    Object.fromEntries(
      (command.inputs ?? []).flatMap((input) =>
        input.kind !== "record" && input.initial !== null
          ? [[input.key, input.initial]]
          : [],
      ),
    ),
  );
  const setValue = (key: string, value: string | number | undefined) =>
    setValues((previous) => {
      const next = { ...previous };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  const complete = (command.inputs ?? []).every((input) =>
    completeOperand(input, values[input.key]),
  );
  const request = reportCommandRequest.safeParse({
    ...command.request,
    ...values,
  });
  return (
    <Row gap="sm" wrap align={compact ? "center" : "end"}>
      {(command.inputs ?? []).map((input) => (
        <CommandOperand
          key={input.key}
          input={input}
          value={values[input.key]}
          disabled={commands.pending}
          compact={compact}
          onChange={(value) => setValue(input.key, value)}
        />
      ))}
      <Button
        type="button"
        size="sm"
        variant={command.prominent ? "default" : "outline"}
        disabled={commands.pending || !complete || !request.success}
        onClick={() => {
          if (request.success && complete) commands.run(request.data);
        }}
      >
        {command.label}
      </Button>
      {commands
        .runsFor(request.success ? request.data : command.request)
        .map((id) => (
          <EntityRefLink
            key={id}
            variant="chip"
            entity="run"
            id={id}
            name={id}
            displayImage={null}
          />
        ))}
    </Row>
  );
}

const completeOperand = (
  input: ReportCommandInput,
  value: string | number | undefined,
) => {
  if (input.kind === "number")
    return z.number().min(input.min).safeParse(value).success;
  if (input.kind === "choice")
    return input.options.some((option) => option.value === value);
  return z.string().trim().min(1).safeParse(value).success;
};

function CommandOperand({
  input,
  value,
  disabled,
  compact,
  onChange,
}: {
  input: ReportCommandInput;
  value: string | number | undefined;
  disabled: boolean;
  compact: boolean;
  onChange: (value: string | number | undefined) => void;
}) {
  if (input.kind === "record")
    return (
      <CommandRecordOperand
        input={input}
        disabled={disabled}
        onChange={onChange}
      />
    );
  // A short choice reads as one segmented control; it needs a current option to show as chosen.
  const chosen =
    compact && input.kind === "choice" && input.options.length <= 3
      ? input.options.find((option) => option.value === value)
      : undefined;
  if (chosen && input.kind === "choice")
    return (
      <ChoiceSwitcher
        ariaLabel={input.label}
        options={input.options}
        value={chosen.value}
        onValueChange={onChange}
      />
    );
  return (
    <label
      className={cn(
        "flex text-xs",
        compact ? "min-w-40 flex-1" : "flex-col gap-1",
      )}
    >
      <span className={cn(compact && "sr-only")}>{input.label}</span>
      {input.kind === "text" ? (
        <Input
          aria-label={input.label}
          placeholder={compact ? input.label : undefined}
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      ) : input.kind === "number" ? (
        <Input
          type="number"
          aria-label={input.label}
          min={input.min}
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            )
          }
        />
      ) : (
        <NativeSelect
          aria-label={input.label}
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">Choose…</option>
          {input.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </label>
  );
}

function CommandRecordOperand({
  input,
  disabled,
  onChange,
}: {
  input: Extract<ReportCommandInput, { kind: "record" }>;
  disabled: boolean;
  onChange: (value: string | number | undefined) => void;
}) {
  const [picked, setPicked] = useState<ComboboxItem | null>(null);
  if (!isReferencePickerEntity(input.entity))
    throw new Error(`No record picker for ${input.entity}`);
  const entity = input.entity;
  const Search = requireReferenceEntitySearch(entity);
  return (
    <Search>
      {({ items, onSearchChange, onOpenChange, isLoading }) => (
        <EntityPicker
          entity={entity}
          label={input.label}
          items={items}
          value={picked}
          setValue={(item) => {
            setPicked(item);
            onChange(item?.id);
          }}
          onSearchChange={onSearchChange}
          onOpenChange={onOpenChange}
          isLoading={isLoading}
          disabled={disabled}
        />
      )}
    </Search>
  );
}
