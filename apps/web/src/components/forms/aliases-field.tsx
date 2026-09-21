import { type Control, Controller, type FieldValues } from "react-hook-form";

import { ChipsInput } from "~/app/_components/forms/chips-input";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";

/**
 * The shared editor for a plain `string[]` form field: chips, typed and
 * committed with Enter/comma/the trailing button, x to remove. Extracted from
 * the ingredient form so ingredients, products, and locations all edit their
 * `aliases` column through one control (all three are searched + embedded on
 * those aliases). The labels default to "Aliases" for those callers;
 * `product.tags` reuses it with its own.
 *
 * Callers are responsible for stripping blank entries before submit — see
 * `filterAliases`.
 */
export function AliasesField<TFieldValues extends FieldValues>({
  form,
  name = "aliases",
  placeholder = "Alias name",
  title = "Aliases",
  // Kept for `product-form-fields.tsx` (PR 3 deletes it, and can't be edited
  // from this PR): the chip input's own text field is the "add" affordance
  // now, so this has nothing left to say.
  addButtonText: _addButtonText,
}: {
  form: { control: Control<TFieldValues> };
  /** Form path holding the `string[]`. Defaults to `aliases`. */
  name?: string;
  placeholder?: string;
  title?: string;
  /** Unused — see the destructured comment above. */
  addButtonText?: string;
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

/** Drop blank/whitespace-only aliases before they hit the API. */
export const filterAliases = (aliases: string[]): string[] =>
  aliases.filter((alias) => alias.trim() !== "");
