"use client";

import type { ReactNode } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
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
  children: (props: {
    items: ComboboxItem[];
    onSearchChange: (query: string) => void;
    isLoading: boolean;
    onCreateNew?: (name: string) => Promise<ComboboxItem>;
  }) => ReactNode;
}

const searchWrapperMap: Record<
  SearchType,
  React.ComponentType<WithEntitySearchProps>
> = {
  ingredient: WithIngredientSearch,
  product: WithProductSearch,
  location: WithLocationSearch,
  recipe: WithRecipeSearch,
};

interface ComboboxFieldWithSearchProps<TFieldValues extends FieldValues> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label?: string;
  searchType: SearchType;
}

/**
 * A convenience wrapper that combines a search hook with ComboboxField.
 * Eliminates the boilerplate of wrapping ComboboxField in WithXxxSearch components.
 *
 * @example
 * // Before:
 * <WithIngredientSearch>
 *   {({ items, onSearchChange, isLoading, onCreateNew }) => (
 *     <ComboboxField
 *       form={form}
 *       name="ingredient"
 *       label="Ingredient"
 *       items={items}
 *       onSearchChange={onSearchChange}
 *       isLoading={isLoading}
 *       onCreateNew={onCreateNew}
 *     />
 *   )}
 * </WithIngredientSearch>
 *
 * // After:
 * <ComboboxFieldWithSearch
 *   form={form}
 *   name="ingredient"
 *   label="Ingredient"
 *   searchType="ingredient"
 * />
 */
export function ComboboxFieldWithSearch<TFieldValues extends FieldValues>({
  form,
  name,
  label,
  searchType,
}: ComboboxFieldWithSearchProps<TFieldValues>) {
  const SearchWrapper = searchWrapperMap[searchType];

  return (
    <SearchWrapper>
      {({ items, onSearchChange, isLoading, onCreateNew }) => (
        <ComboboxField
          form={form}
          name={name}
          label={label}
          items={items}
          onSearchChange={onSearchChange}
          isLoading={isLoading}
          onCreateNew={onCreateNew}
        />
      )}
    </SearchWrapper>
  );
}
