import { mealDate } from "@cubby/schemas/meal";
import {
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import { format, parseISO } from "date-fns";
import { useMemo } from "react";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { mealMutationInvalidateKeys } from "~/lib/query-keys";
import {
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { mealKindOptions, mealTypeOptions } from "./meal-options";

// `name` stays a plain (non-nullable) string here — quick capture allows an
// unnamed meal (identified by its date, same as everywhere else in the meal
// UI); the empty-string → null normalization happens in buildPayload, not
// the schema, matching quickAddExpenseSchema's `vendor` field.
const quickAddMealSchema = z.object({
  date: mealDate,
  name: z.string(),
  mealType: mealTypeSchema.nullable(),
  mealKind: mealKindSchema,
});
type QuickAddMealValues = z.infer<typeof quickAddMealSchema>;

// A thunk, not a value — "today" must re-resolve every time the dialog
// opens, not freeze at whenever this module first evaluated. No props to
// close over, so a stable module-level function needs no useMemo.
const defaultValues = (): QuickAddMealValues => ({
  date: format(new Date(), "yyyy-MM-dd"),
  name: "",
  // Unslotted by default — quick capture shouldn't invent a slot the user
  // didn't pick, and null is a first-class value of this column.
  mealType: null,
  mealKind: "cooked",
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
      entity="meal"
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
        mealType: values.mealType,
        mealKind: values.mealKind,
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
          <SelectField
            form={form}
            name="mealType"
            label="Meal type"
            options={mealTypeOptions}
            placeholder="Which meal of the day?"
            nullable
          />
          <SelectField
            form={form}
            name="mealKind"
            label="Kind"
            options={mealKindOptions}
            description="Eating out or ordering in? Leave the recipes empty — that's a complete record, not an unfinished one."
          />
        </>
      )}
    </QuickAddDialog>
  );
}
