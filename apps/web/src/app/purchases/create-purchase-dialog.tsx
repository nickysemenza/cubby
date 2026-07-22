import type { ProjectId } from "@cubby/schemas/identifiers";
import { unsafeProjectId } from "@cubby/schemas/identifiers";
import { costTypeSchema, plainDate, tradeSchema } from "@cubby/schemas/project";
import { format } from "date-fns";
import { useMemo } from "react";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { tradeOptions } from "~/app/projects/shared";
import { Row } from "~/components/layout";
import { Switch } from "~/components/ui/switch";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { FormFieldGroup } from "../_components/forms/form-field-group";
import { costTypeOptions } from "./purchase-options";

const today = () => format(new Date(), "yyyy-MM-dd");

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in buildPayload via `unsafeProjectId`.
// `name` is the only truly required field — `trade`/`costType` now default
// (see `defaultValues` below) rather than forcing a choice via `.refine()`.
const quickAddPurchaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  cost: z.number().nullable(),
  date: plainDate.nullable(),
  projectId: z.string().nullable(),
  costType: costTypeSchema,
  trade: tradeSchema,
  future: z.boolean(),
});
type QuickAddPurchaseValues = z.infer<typeof quickAddPurchaseSchema>;

interface CreatePurchaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Pre-fill the project from a project detail page's "New purchase" button.
   * Read once, on mount — the caller conditionally mounts a fresh dialog
   * instance per click (see `CreateTaskDialog`'s `presetProjectId`).
   */
  presetProjectId?: ProjectId | null;
}

export function CreatePurchaseDialog({
  open,
  onOpenChange,
  presetProjectId,
}: CreatePurchaseDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  const defaultValues = useMemo<QuickAddPurchaseValues>(
    () => ({
      name: "",
      cost: null,
      date: today(),
      projectId: presetProjectId ?? null,
      // "other"/"materials" are the least-wrong defaults for a fresh quick
      // capture — most household purchases are an untriaged materials buy;
      // both are one click to correct via the row's inline-editable columns.
      costType: "materials",
      trade: "other",
      future: false,
    }),
    [presetProjectId],
  );

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddPurchaseSchema}
      defaultValues={defaultValues}
      title="New Purchase"
      description="Log what you bought (or plan to) — the fastest way to keep a project's cost honest."
      mutationFn={api.purchase.create.mutationOptions}
      successMessage={(purchase) => `Logged "${purchase.name}"`}
      invalidateKeys={purchaseMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        cost: values.cost,
        date: values.date,
        projectId: values.projectId ? unsafeProjectId(values.projectId) : null,
        costType: values.costType,
        trade: values.trade,
        url: null,
        notes: null,
        future: values.future,
      })}
    >
      {(form) => (
        <>
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="What did you buy?"
            autoFocus
          />
          <NullableNumericField
            form={form}
            name="cost"
            label="Cost"
            placeholder="e.g. 24.99"
            step="0.01"
            prefix="$"
          />
          <Controller
            control={form.control}
            name="future"
            render={({ field: futureField }) => (
              <>
                <FormFieldGroup label="Planned">
                  <Row align="center" gap="sm">
                    <Switch
                      checked={futureField.value}
                      onCheckedChange={(checked) => {
                        futureField.onChange(checked);
                        // Untouched-and-still-today's-default date flips with
                        // the toggle: Planned clears it (no expected date
                        // yet), Actual re-defaults it to today. A date the
                        // user has actually edited (`dirtyFields.date`) is
                        // left alone either way. `shouldDirty: false` on
                        // these programmatic writes keeps `dirtyFields.date`
                        // reserved for genuine user edits.
                        const dateTouched = Boolean(
                          form.formState.dirtyFields.date,
                        );
                        const currentDate = form.getValues("date");
                        if (checked) {
                          if (!dateTouched && currentDate === today()) {
                            form.setValue("date", null, {
                              shouldDirty: false,
                            });
                          }
                        } else if (currentDate === null) {
                          form.setValue("date", today(), {
                            shouldDirty: false,
                          });
                        }
                      }}
                    />
                    <span className="text-muted-foreground text-sm">
                      {futureField.value ? "Not bought yet" : "Already bought"}
                    </span>
                  </Row>
                </FormFieldGroup>
                <PlainDateField
                  form={form}
                  name="date"
                  label={futureField.value ? "Expected date" : "Purchase date"}
                />
              </>
            )}
          />
          <SelectField
            form={form}
            name="costType"
            label="Cost Type"
            options={costTypeOptions}
          />
          <SelectField
            form={form}
            name="trade"
            label="Trade"
            options={tradeOptions}
          />
          <SelectField
            form={form}
            name="projectId"
            label="Project"
            options={projectOptions}
            nullable
          />
        </>
      )}
    </QuickAddDialog>
  );
}
