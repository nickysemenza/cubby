import type {
  FieldPathByValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";

import type { ProductPickerIntent } from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";
import { WithEntitySearch } from "../combobox/with-search-hook";
import { ComboboxField } from "../form-utils";

type SearchType = "ingredient" | "product" | "location" | "recipe";

interface ComboboxFieldWithSearchProps<
  TFieldValues extends FieldValues,
  TName extends FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>,
> {
  form: UseFormReturn<TFieldValues>;
  name: TName;
  label?: string;
  searchType: SearchType;
  productIntent?: ProductPickerIntent;
  disabledItemReasons?: Readonly<Record<string, string>>;
  /** The manifest target key this field suggests, e.g. `"locationId"`. */
  suggestField?: string;
}

/**
 * A convenience wrapper that combines a search hook with ComboboxField.
 * Eliminates the boilerplate of wrapping ComboboxField in WithXxxSearch components.
 */
export function ComboboxFieldWithSearch<
  TFieldValues extends FieldValues,
  TName extends FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>,
>({
  form,
  name,
  label,
  searchType,
  productIntent,
  disabledItemReasons,
  suggestField,
}: ComboboxFieldWithSearchProps<TFieldValues, TName>) {
  return (
    <WithEntitySearch
      entity={searchType}
      intent={searchType === "product" ? productIntent : undefined}
    >
      {({ items, onSearchChange, isLoading, onCreateNew, onOpenChange }) => (
        <ComboboxField
          form={form}
          name={name}
          label={label}
          items={items}
          onSearchChange={onSearchChange}
          isLoading={isLoading}
          onCreateNew={onCreateNew}
          onOpenChange={onOpenChange}
          entity={searchType}
          disabledItemReasons={disabledItemReasons}
          suggestField={suggestField}
        />
      )}
    </WithEntitySearch>
  );
}
