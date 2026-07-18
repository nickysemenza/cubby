import {
  Controller,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from "react-hook-form";
import { Input } from "~/components/ui/input";
import { FormFieldGroup } from "../_components/forms/form-field-group";

/**
 * A plain "YYYY-MM-DD" calendar-date field (task due date, purchase date) —
 * a raw `<input type="date">` already returns that exact string, so no
 * parsing/formatting is needed on either side. There's no shared date-picker
 * component in the app yet (see `add-to-meal.tsx` for the same raw-input
 * pattern); this is a thin `FormFieldGroup`-wrapped Controller mirroring the
 * other field helpers in `form-utils.tsx`.
 */
export function PlainDateField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={name}
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Input
            id={name}
            type="date"
            value={(field.value as string | null) ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              field.onChange(v === "" ? null : v);
            }}
            aria-invalid={fieldState.invalid}
          />
        </FormFieldGroup>
      )}
    />
  );
}
