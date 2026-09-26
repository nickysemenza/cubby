import type {
  FieldPathByValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";

import type { ProductPickerIntent } from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";
import { useEntityListSource } from "../combobox/with-search-hook";
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
 * `ComboboxField` fed by `useEntityListSource(searchType)`.
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
  const { dialog, ...search } = useEntityListSource(searchType, {
    intent: productIntent,
  });
  return (
    <>
      {dialog}
      <ComboboxField
        form={form}
        name={name}
        label={label}
        {...search}
        entity={searchType}
        disabledItemReasons={disabledItemReasons}
        suggestField={suggestField}
      />
    </>
  );
}
