import {
  Controller,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from "react-hook-form";
import { Input } from "~/components/ui/input";
import { FormFieldGroup } from "../_components/forms/form-field-group";

/**
 * A plain "YYYY-MM-DD" calendar-date field (project start date) — a raw
 * `<input type="date">` already returns that exact string, so no
 * parsing/formatting is needed on either side. Mirrors
 * `tasks/plain-date-field.tsx` / `purchases/plain-date-field.tsx` — there's no
 * shared date-picker component in the app yet, so each quick-add domain keeps
 * its own thin `FormFieldGroup`-wrapped Controller.
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
