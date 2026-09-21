import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  costTypeSchema,
  type ExpenseOut,
  plainDate,
  tradeSchema,
} from "@cubby/schemas/project";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { tradeOptions } from "~/app/projects/shared";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

import {
  FormWrapper,
  NullableNumericField,
  NullableTextareaField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { VendorField } from "../_components/form-utils/vendor-field";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { costTypeOptions } from "./expense-options";

// projectId stays a plain string here (not the branded schema) — it's the raw
// value out of the `SelectField` dropdown; the ProjectShortcode brand is
// parsed at the server-call boundary in onSubmit,
// same convention as the Expense capture intent. `cost` is nullable +
// refined (not a plain `z.number()`) so a cleared input reads as `null` (not
// `undefined`) for `NullableNumericField` while still being rejected as
// required — same idiom as the costType/trade refines below and in
// the generic Expense editor.
const settleExpenseSchema = z.object({
  cost: z
    .number()
    .nullable()
    .refine((v): boolean => v !== null, "Final cost is required"),
  date: plainDate,
  projectId: z.string().nullable(),
  costType: costTypeSchema,
  trade: tradeSchema.nullable(),
  notes: z.string().nullable(),
  vendor: z.string(),
  orderId: z.string(),
});
type SettleExpenseValues = z.infer<typeof settleExpenseSchema>;

interface SettleExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: ExpenseOut;
}

/**
 * "Mark purchased" — settles a planned expense in one write: the final cost,
 * the actual date (defaults to today), and a chance to correct the project /
 * cost type / trade / notes now that the expense actually happened. Flips
 * `future: false` in the SAME `expense.update` call, not a separate mutation
 * (see the Planned-view row action in `expenselist.tsx`).
 */
export function SettleExpenseDialog({
  open,
  onOpenChange,
  expense,
}: SettleExpenseDialogProps) {
  const defaultValues = useMemo<SettleExpenseValues>(
    () => ({
      cost: expense.cost,
      date: format(new Date(), "yyyy-MM-dd"),
      projectId: expense.projectId ?? null,
      costType: expense.costType,
      trade: expense.trade,
      notes: expense.notes,
      vendor: expense.vendor ?? "",
      orderId: expense.orderId ?? "",
    }),
    [expense],
  );

  const form = useForm<SettleExpenseValues>({
    resolver: zodResolver(settleExpenseSchema),
    defaultValues,
  });

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });

  const onSubmit = (values: SettleExpenseValues) => {
    updateMutation.mutate(
      {
        id: expense.id,
        data: {
          // Non-null by the schema refine above — zod has already rejected
          // null before onSubmit runs.
          cost: values.cost!,
          date: values.date,
          projectId: values.projectId
            ? parseShortcodeFor("project", values.projectId)
            : null,
          costType: values.costType,
          trade: values.trade,
          notes: values.notes,
          vendor: values.vendor.trim() || null,
          orderId: values.orderId.trim() || null,
          future: false,
        },
      },
      {
        onSuccess: () => {
          form.reset(defaultValues);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaultValues);
        onOpenChange(next);
      }}
      title={`Mark "${expense.name}" purchased`}
      description="Log the final cost and date — this moves the expense off the Planned list."
      bodyMode="form"
    >
      <FormWrapper<SettleExpenseValues>
        form={form}
        onSubmit={onSubmit}
        isPending={updateMutation.isPending}
        error={updateMutation.error ? updateMutation.error.message : undefined}
        onCancel={() => onOpenChange(false)}
        submitButtonText="Mark purchased"
        footerMode="dialog"
      >
        {/* `FormWrapper` already mounts its own `<FormProvider>`, which is
        what `FieldSuggestionProvider` reads its live form state from — no
        second provider needed. `productId`/`name`/`notes` aren't rendered
        here, so they ride as a fixed basis rather than a live watch. */}
        <FieldSuggestionProvider
          entity="expense"
          mode="edit"
          staticBasis={{
            name: expense.name,
            productId: expense.productId,
            purchaseId: expense.purchaseId,
            lineKind: expense.lineKind,
            notes: expense.notes,
          }}
          fieldKeys={[
            "costType",
            "trade",
            ...(expense.lineKind === "principal" ? ["projectId"] : []),
            "vendor",
          ]}
        >
          <NullableNumericField
            form={form}
            name="cost"
            label="Final cost"
            placeholder="e.g. 24.99"
            step="0.01"
            prefix="$"
          />
          <PlainDateField form={form} name="date" label="Expense date" />
          <SelectField
            form={form}
            name="costType"
            label="Cost Type"
            options={costTypeOptions}
            suggestField="costType"
          />
          <SelectField
            form={form}
            name="trade"
            label="Trade"
            options={tradeOptions}
            nullable
            description="None keeps the trade inherited from its project or purchase defaults."
            suggestField="trade"
          />
          {expense.lineKind === "principal" ? (
            <EntityValueField<SettleExpenseValues, "project">
              form={form}
              name="projectId"
              entity="project"
              label="Project"
              SearchProvider={(props) => (
                <WithEntitySearch entity="project" {...props} />
              )}
              clearable
              suggestField="projectId"
            />
          ) : null}
          {/* Roster picker, not free text — see `VendorField`. */}
          <VendorField
            form={form}
            name="vendor"
            label="Vendor"
            suggestField="vendor"
          />
          <UnifiedTextField
            form={form}
            name="orderId"
            label="Order #"
            placeholder="Vendor order #"
          />
          <NullableTextareaField
            form={form}
            name="notes"
            label="Notes"
            placeholder="Optional notes"
          />
        </FieldSuggestionProvider>
      </FormWrapper>
    </ResponsiveDialog>
  );
}
