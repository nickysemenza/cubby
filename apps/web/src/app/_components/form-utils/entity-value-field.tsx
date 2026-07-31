import type { ReactNode } from "react";
import {
  Controller,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";
import type { ComboboxItem, PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { FormFieldGroup } from "../forms/form-field-group";

/** React Hook Form adapter for assignments whose persisted value is the id. */
export function EntityValueField<
  TFieldValues extends FieldValues,
  TId extends string,
>({
  form,
  name,
  entity,
  label,
  placeholder,
  SearchProvider,
  clearable,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  entity: PickerEntity;
  label?: string;
  placeholder?: string;
  SearchProvider: (props: WithEntitySearchProps<TId>) => ReactNode;
  clearable?: boolean;
}) {
  return (
    <SearchProvider>
      {({ items, onSearchChange, isLoading, onCreateNew, onOpenChange }) => (
        <Controller
          control={form.control}
          name={name}
          render={({ field, fieldState }) => {
            const id = (field.value as TId | null | undefined) ?? null;
            const selected =
              items.find((item) => item.id === id) ??
              (id
                ? ({ id, shortcode: id, name: id } satisfies ComboboxItem<TId>)
                : null);
            return (
              <FormFieldGroup
                htmlFor={name}
                label={label}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                <EntityPicker
                  entity={entity}
                  label={entity}
                  placeholder={placeholder}
                  items={items}
                  value={selected}
                  setValue={(item) =>
                    field.onChange(
                      (item?.id ?? "") as PathValue<
                        TFieldValues,
                        Path<TFieldValues>
                      >,
                    )
                  }
                  onSearchChange={onSearchChange}
                  isLoading={isLoading}
                  onCreateNew={onCreateNew}
                  onOpenChange={onOpenChange}
                  clearable={clearable}
                />
              </FormFieldGroup>
            );
          }}
        />
      )}
    </SearchProvider>
  );
}
