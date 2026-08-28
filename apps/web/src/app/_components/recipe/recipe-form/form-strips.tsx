import { sumBy } from "es-toolkit";
import { type FC, useId } from "react";
import {
  type Control,
  Controller,
  type useForm,
  useFormState,
  useWatch,
} from "react-hook-form";

import { Row, Stack } from "~/components/layout";
import { InkStamp } from "~/components/ui/ink-stamp";
import { Input } from "~/components/ui/input";

import { NullableNumericField, SideBySideFields } from "../../form-utils";
import { FormFieldGroup } from "../../forms/form-field-group";
import type { RecipeFormValues } from "./types";

// Yield and Servings fields with smart hide behavior
export const YieldServingsFields: FC<{
  form: ReturnType<typeof useForm<RecipeFormValues>>;
}> = ({ form }) => {
  const yieldUnitId = useId();
  const yieldUnit = useWatch({ control: form.control, name: "yield.unit" });

  // Show servings field if yield unit is set and not "servings"
  const showServings = yieldUnit && yieldUnit !== "servings";

  return (
    <Stack gap="sm">
      <SideBySideFields>
        <NullableNumericField
          form={form}
          name="yield.value"
          label="Yield Value (Optional)"
          placeholder="e.g., 24"
        />
        <Controller
          control={form.control}
          name="yield.unit"
          render={({ field }) => (
            <FormFieldGroup htmlFor={yieldUnitId} label="Yield Unit">
              <Input
                id={yieldUnitId}
                placeholder="e.g., cookies, servings, cups"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            </FormFieldGroup>
          )}
        />
      </SideBySideFields>

      {showServings && (
        <NullableNumericField
          form={form}
          name="servings"
          label="Servings"
          placeholder="How many portions?"
        />
      )}
    </Stack>
  );
};

// Live tally for the sticky footer: counts + a dirty stamp. Subscribed
// narrowly via control so keystrokes re-render this strip, not the form.
export const EditorTally: FC<{ control: Control<RecipeFormValues> }> = ({
  control,
}) => {
  const sections = useWatch({ control, name: "sections" });
  // dirtyFields, not isDirty: registering the URL/yield inputs materializes
  // their objects ({url: undefined} vs null), which trips isDirty on load.
  const { dirtyFields } = useFormState({ control });
  const isDirty = Object.keys(dirtyFields).length > 0;
  const ingredients = sumBy(sections ?? [], (s) => s?.ingredients?.length ?? 0);
  const steps = sumBy(sections ?? [], (s) => s?.instructions?.length ?? 0);

  return (
    <Row
      align="center"
      gap="sm"
      className="min-w-0 font-mono text-2xs text-muted-foreground uppercase"
    >
      <span className="truncate tabular-nums">
        {ingredients} ingredients · {steps} steps
      </span>
      {isDirty && <InkStamp tone="red">Unsaved</InkStamp>}
    </Row>
  );
};
