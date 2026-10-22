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
import { workflowCommandBody } from "@cubby/schemas/workflow-command";
import { useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useDeferredActionMutation } from "~/entity/hooks/use-action-mutation";
import { useWorkflowCommand } from "~/entity/hooks/use-workflow-command";
import { Picker } from "~/entity/picker/picker";
import { requireReferenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { readPathValue } from "~/entity/read-path";
import { workflowCommandMetadata } from "~/integrations/tanstack-query/generated/commands.gen";
import { cn } from "~/lib/utils";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { isReferencePickerEntity } from "~/ui/combobox/reference-picker-entities";
import { Row } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

/** Runs ordinary commands with the catalog's validation, cache ripple and result effects. */
export function useReportCommands() {
  const ordinary = useWorkflowCommand();
  const reprocess = useDeferredActionMutation({
    loadMutation: async () =>
      (
        await import("~/integrations/tanstack-query/generated/catalog/recipe.gen")
      ).recipe.reprocessCookbookOnce.mutationOptions(),
    error: "Could not reprocess the cookbook",
  });
  const importRecipes = useDeferredActionMutation({
    loadMutation: async () =>
      (
        await import("~/integrations/tanstack-query/generated/catalog/recipe.gen")
      ).recipe.importCookbookRecipesOnce.mutationOptions(),
    error: "Could not add the recipes",
  });
  const commit = useDeferredActionMutation({
    loadMutation: async () =>
      (
        await import("~/integrations/tanstack-query/generated/catalog/run.gen")
      ).run.commitPrepared.mutationOptions(),
    error: "Could not import the prepared orders",
  });
  return {
    runsFor: (request: ReportCommandRequest): readonly string[] => {
      if (
        request.kind !== "operation" ||
        !ordinary.data ||
        JSON.stringify(ordinary.data.request) !== JSON.stringify(request)
      )
        return [];
      const path = workflowCommandMetadata(request.operation).runIdsPath;
      const value = path
        ? readPathValue(ordinary.data.result, path)
        : undefined;
      return typeof value === "string"
        ? [value]
        : (z.array(z.string()).safeParse(value).data ?? []);
    },
    result: ordinary.data?.result,
    pending:
      ordinary.isPending ||
      reprocess.isPending ||
      importRecipes.isPending ||
      commit.isPending,
    committed: commit.isSuccess,
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
        .with({ kind: "operation" }, (request) => ordinary.mutate(request))
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
        .exhaustive(),
  };
}

export type ReportCommands = ReturnType<typeof useReportCommands>;

/** Collects the declared operands, then confirms the exact command before dispatch. */
export function CommandButton({
  command,
  commands,
  compact = false,
  quiet = false,
}: {
  command: ReportCommand;
  commands: ReportCommands;
  /** One inline line: inputs carry their label as their accessible name, not a stacked caption. */
  compact?: boolean;
  /** A row command inside a ledger line: ghost unless prominent, within the row's height. */
  quiet?: boolean;
}) {
  const [staged, setStaged] = useState<ReportCommandRequest | null>(null);
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
  const metadata =
    command.request.kind === "operation"
      ? workflowCommandMetadata(command.request.operation)
      : undefined;
  const confirmation = command.confirm ?? metadata?.confirmation;
  const request = reportCommandRequest.safeParse(
    command.request.kind === "operation"
      ? {
          ...command.request,
          body: workflowCommandBody(
            command.request,
            values,
            metadata?.booleanInputs,
          ),
        }
      : command.request,
  );
  // The selected command's validator loads at execution, inside the existing
  // pending/error flow, rather than pulling every command schema into the page.
  const validBody = request.success;
  return (
    <Row gap="sm" wrap align={compact ? "center" : "end"}>
      <Overlay
        open={staged !== null}
        onOpenChange={(open) => {
          if (!open) setStaged(null);
        }}
        title={command.label}
        description={confirmation}
        pending={commands.pending}
        primary={{
          label: command.label,
          disabled:
            !complete ||
            !validBody ||
            !request.success ||
            JSON.stringify(staged) !== JSON.stringify(request.data),
          onClick: () => {
            if (
              staged &&
              request.success &&
              complete &&
              validBody &&
              JSON.stringify(staged) === JSON.stringify(request.data)
            ) {
              commands.run(staged);
              setStaged(null);
            }
          },
        }}
      />
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
        variant={command.prominent ? "default" : quiet ? "ghost" : "outline"}
        className={quiet ? "h-6" : undefined}
        disabled={commands.pending || !complete || !validBody}
        onClick={() => {
          if (request.success && complete && validBody) {
            if (confirmation) setStaged(request.data);
            else commands.run(request.data);
          }
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
      <Picker
        mode="segmented"
        label={input.label}
        options={input.options}
        value={chosen.value}
        onValueChange={(next) => onChange(next ?? undefined)}
      />
    );
  return (
    <div
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
        <Picker
          mode="choose"
          clearable
          compact={compact}
          className={cn(compact && "flex-1")}
          label={input.label}
          placeholder="Choose…"
          options={input.options}
          value={value == null ? null : String(value)}
          disabled={disabled}
          onValueChange={(next) => onChange(next || undefined)}
        />
      )}
    </div>
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
        <Picker
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
