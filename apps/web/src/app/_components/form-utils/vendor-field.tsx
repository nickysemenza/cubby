import {
  Controller,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";

import { AutoSuggestSlot } from "~/app/_components/ai/auto-suggest-slot";

import { EntityPicker } from "../combobox/entity-picker";
import {
  type VendorName,
  WithVendorSearch,
} from "../combobox/with-vendor-search";
import { FormFieldGroup } from "../forms/form-field-group";

/**
 * A **name-valued** vendor picker for react-hook-form, for the create/settle
 * expense dialogs where a brand-new vendor actually gets typed.
 *
 * Why not a text input: `findOrCreateVendor` matches names EXACTLY (trimmed,
 * case-sensitive, deliberately — case-folding would merge a genuine `3M`/`3m`
 * distinction), so free text mints a duplicate roster row on any typo, with no
 * detector to catch it. This offers the whole `vendor.options` roster and saves
 * the picked option's name **verbatim**; typing a genuinely new vendor still
 * works — a first purchase at a new store shouldn't need a detour to /vendors —
 * but is no longer the accidental default, because
 * `EntityPicker` surfaces "Create vendor: …" only once the
 * typed term matches nothing on the roster.
 *
 * The field's value stays a **plain name string** (`""` when empty), not a
 * `ComboboxItem` — unlike `ComboboxField`, whose id-valued entity pickers store
 * the whole item. That keeps callers' `values.vendor.trim() || null` intact and
 * the server contract (`expenseUpdateData.vendor` is a NAME) untouched; the
 * `id === name` combobox identity is what makes the round trip free. Rendered
 * inside the generic entity dialog/`ResponsiveDialog`, hence the dialog-compatible
 * combobox rather than the standard one.
 */
export function VendorField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label = "Vendor",
  placeholder = "Where from?",
  suggestField,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label?: string;
  /**
   * Empty-trigger prompt. Defaults to the "Where from?" an incoming expense
   * asks; a disposition (negative cost) records who you sold TO, so it passes
   * "Sold to / given to" instead.
   */
  placeholder?: string;
  /** The manifest target key this field suggests, e.g. `"vendor"` — a text
   * roster target, so the suggested value is the vendor name string itself. */
  suggestField?: string;
}) {
  return (
    <WithVendorSearch>
      {({ items, onSearchChange, isLoading, onCreateNew, onOpenChange }) => (
        <Controller
          control={form.control}
          name={name}
          render={({ field, fieldState }) => {
            const vendor = String(field.value ?? "");
            return (
              <FormFieldGroup
                htmlFor={name}
                label={label}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                <EntityPicker<VendorName>
                  entity="vendor"
                  // Lowercase "vendor" (not the field's label) so the dropdown
                  // reads "Search vendor…" / "Create new vendor: Ace Hardware".
                  label="vendor"
                  placeholder={placeholder}
                  items={items}
                  onSearchChange={onSearchChange}
                  isLoading={isLoading}
                  value={vendor ? { id: vendor, name: vendor } : null}
                  // Deselecting the current row clears the field, and an empty
                  // string is what the callers' `.trim() || null` turns into a
                  // null vendor — the same thing emptying the old text input did.
                  setValue={(item) =>
                    field.onChange(
                      // SAFETY: `name` is a caller-owned Path whose value is
                      // the vendor-name string; RHF cannot derive that value
                      // relationship from the generic form type here.
                      (item?.id ?? "") as PathValue<
                        TFieldValues,
                        Path<TFieldValues>
                      >,
                    )
                  }
                  onCreateNew={onCreateNew}
                  onOpenChange={onOpenChange}
                  clearable
                />
                {suggestField && (
                  <AutoSuggestSlot
                    form={form}
                    name={name}
                    field={suggestField}
                  />
                )}
              </FormFieldGroup>
            );
          }}
        />
      )}
    </WithVendorSearch>
  );
}
