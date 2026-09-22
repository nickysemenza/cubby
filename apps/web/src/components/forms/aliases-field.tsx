import { type Control, Controller, type FieldValues } from "react-hook-form";

import { ChipsInput } from "~/app/_components/forms/chips-input";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";

/**
 * The shared editor for a plain `string[]` form field: chips, typed and
 * committed with Enter/comma/the trailing button, x to remove. Extracted from
 * the ingredient form so ingredients, products, and locations all edit their
 * `aliases` column through one control (all three are searched + embedded on
 * those aliases). Blank entries can't reach this field — `ChipsInput`'s own
 * `addTag` already trims and drops an empty value before it calls `onChange`.
 */
export function AliasesField<TFieldValues extends FieldValues>({
  form,
  name = "aliases",
  placeholder = "Alias name",
  title = "Aliases",
}: {
  form: { control: Control<TFieldValues> };
  /** Form path holding the `string[]`. Defaults to `aliases`. */
  name?: string;
  placeholder?: string;
  title?: string;
}) {
  return (
    <Controller
      control={form.control}
      // SAFETY: the path is a caller-supplied `name`, so React Hook Form
      // cannot verify it against TFieldValues here.
      name={name as Parameters<typeof Controller<TFieldValues>>[0]["name"]}
      render={({ field }) => (
        <FormFieldGroup label={title}>
          <ChipsInput
            // SAFETY: `Array.isArray` above confirms the runtime shape; the
            // `name` field is a caller-declared `string[]` path, but RHF's
            // dynamic `name` cast (above) already erased that to `unknown`.
            value={Array.isArray(field.value) ? (field.value as string[]) : []}
            onChange={field.onChange}
            placeholder={placeholder}
          />
        </FormFieldGroup>
      )}
    />
  );
}
