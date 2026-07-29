import { mealDate } from "@cubby/schemas/meal";
import { format, parseISO } from "date-fns";
import { useMemo } from "react";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { mealMutationInvalidateKeys } from "~/lib/query-keys";
import { PlainDateField, UnifiedTextField } from "../_components/form-utils";

// `name` stays a plain (non-nullable) string here — quick capture allows an
// unnamed meal (identified by its date, same as everywhere else in the meal
// UI); the empty-string → null normalization happens in buildPayload, not
// the schema, matching quickAddExpenseSchema's `vendor` field.
const quickAddMealSchema = z.object({
  date: mealDate,
  name: z.string(),
});
type QuickAddMealValues = z.infer<typeof quickAddMealSchema>;

// A thunk, not a value — "today" must re-resolve every time the dialog
// opens, not freeze at whenever this module first evaluated. No props to
// close over, so a stable module-level function needs no useMemo.
const defaultValues = (): QuickAddMealValues => ({
  date: format(new Date(), "yyyy-MM-dd"),
  name: "",
});

interface CreateMealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetDate?: string;
}

export function CreateMealDialog({
  open,
  onOpenChange,
  presetDate,
}: CreateMealDialogProps) {
  const api = useTRPC();
  const initialValues = useMemo(
    () => () => {
      const values = defaultValues();
      return { ...values, date: presetDate ?? values.date };
    },
    [presetDate],
  );

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddMealSchema}
      defaultValues={initialValues}
      title="New Meal"
      description="Plan a meal onto the calendar — add recipes once it's created."
      mutationFn={api.meal.create.mutationOptions}
      successMessage={(meal) =>
        meal.name
          ? `Added "${meal.name}"`
          : `Added meal for ${format(parseISO(meal.date), "EEE, MMM d")}`
      }
      invalidateKeys={mealMutationInvalidateKeys}
      buildPayload={(values) => ({
        date: values.date,
        name: values.name.trim() || null,
      })}
    >
      {(form) => (
        <>
          <PlainDateField form={form} name="date" label="Date" />
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="Meal name (optional)"
            autoFocus
          />
        </>
      )}
    </QuickAddDialog>
  );
}
