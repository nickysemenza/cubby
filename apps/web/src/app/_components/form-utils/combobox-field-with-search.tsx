import type { ReactNode } from "react";
import type {
  FieldPathByValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";

import type { ProductPickerIntent } from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";
import {
  WithIngredientSearch,
  WithLocationSearch,
  WithProductSearch,
  WithRecipeSearch,
} from "../combobox/with-search-hook";
import { ComboboxField } from "../form-utils";

type SearchType = "ingredient" | "product" | "location" | "recipe";

interface WithEntitySearchProps {
  intent?: ProductPickerIntent;
  children: (props: {
    items: ComboboxItem[];
    onSearchChange: (query: string) => void;
    isLoading: boolean;
    onCreateNew?: (name: string) => Promise<ComboboxItem>;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}

const searchWrapperMap = {
  ingredient: WithIngredientSearch,
  product: WithProductSearch,
  location: WithLocationSearch,
  recipe: WithRecipeSearch,
} satisfies Record<SearchType, React.ComponentType<WithEntitySearchProps>>;

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
}: ComboboxFieldWithSearchProps<TFieldValues, TName>) {
  const SearchWrapper = searchWrapperMap[searchType];

  return (
    <SearchWrapper
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
        />
      )}
    </SearchWrapper>
  );
}
