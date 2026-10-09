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
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  meal,
  problems,
  recipe,
  run,
  vendor,
} from "~/integrations/tanstack-query/generated/catalog.gen";
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

/** Runs a row command through the operation it names; the server composed the exact body. */
export function useReportCommands() {
  const mailDecision = useActionMutation({
    mutationFn: vendor.decideOrderMail.mutationOptions,
    error: "Could not update the email relationship",
  });
  const mailResearch = useActionMutation({
    mutationFn: vendor.importOrderMail.mutationOptions,
    error: "Could not research the original email",
    success: ({ runIds }) => `Research Runs: ${runIds.join(", ")}`,
  });
  const vendorResearch = useActionMutation({
    mutationFn: run.startTargeted.mutationOptions,
    error: "Could not research purchases",
    onSuccess: ({ runs }) => {
      const first = runs[0];
      const created = first?.run ?? first?.blockingRun;
      if (created) window.location.assign(runHref(created.id));
    },
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
    runsFor: (request: ReportCommandRequest): readonly string[] => {
      if (
        request.kind === "research-order-mail" &&
        mailResearch.variables?.eventId === request.eventId &&
        mailResearch.variables.evidenceChecksum === request.evidenceChecksum
      )
        return mailResearch.data?.runIds ?? [];
      if (
        request.kind === "research-vendor-purchases" &&
        vendorResearch.variables?.purpose === "account_sync" &&
        vendorResearch.variables.vendorId === request.vendorId
      )
        return (
          vendorResearch.data?.runs.flatMap((result) => {
            const started = result.run?.id ?? result.blockingRun?.id;
            return started ? [started] : [];
          }) ?? []
        );
      return [];
    },
    pending:
      mailDecision.isPending ||
      mailResearch.isPending ||
      vendorResearch.isPending ||
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
        .with({ kind: "decide-order-mail" }, (r) => {
          if (r.purchaseId)
            mailDecision.mutate({
              eventId: r.eventId,
              purchaseId: r.purchaseId,
              decision: r.decision,
              evidenceChecksum: r.evidenceChecksum,
            });
        })
        .with({ kind: "research-order-mail" }, (r) =>
          mailResearch.mutate({
            eventId: r.eventId,
            evidenceChecksum: r.evidenceChecksum,
          }),
        )
        .with({ kind: "research-vendor-purchases" }, (r) =>
          vendorResearch.mutate({
            purpose: "account_sync",
            vendorId: r.vendorId,
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
}: {
  command: ReportCommand;
  commands: ReportCommands;
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
    <Row gap="sm" wrap align="end">
      {(command.inputs ?? []).map((input) => (
        <CommandOperand
          key={input.key}
          input={input}
          value={values[input.key]}
          disabled={commands.pending}
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
  onChange,
}: {
  input: ReportCommandInput;
  value: string | number | undefined;
  disabled: boolean;
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
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span>{input.label}</span>
      {input.kind === "number" ? (
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
