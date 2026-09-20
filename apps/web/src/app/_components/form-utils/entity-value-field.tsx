import {
  parseShortcodeFor,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { ReactNode } from "react";
import {
  Controller,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import { FieldSuggestionHint } from "~/app/_components/ai/field-suggestion-hint";
import { useAutoFieldSuggestion } from "~/app/_components/ai/use-auto-field-suggestion";

import type { ComboboxItem, PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
import type { EntitySearchScope } from "../combobox/entity-search-hooks";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { FormFieldGroup } from "../forms/form-field-group";

/** React Hook Form adapter for assignments whose persisted value is the id. */
export function EntityValueField<
  TFieldValues extends FieldValues,
  E extends PickerEntity,
>({
  form,
  name,
  entity,
  label,
  placeholder,
  SearchProvider,
  clearable,
  suggestField,
  description,
  scope,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  entity: E;
  label?: string;
  placeholder?: string;
  SearchProvider: (props: WithEntitySearchProps<ShortcodeFor<E>>) => ReactNode;
  clearable?: boolean;
  description?: ReactNode;
  /** Dependent-field filters for the candidate picker; null keeps it scoped but idle. */
  scope?: EntitySearchScope | null;
  /** The manifest target key this field suggests (e.g. `"projectId"`). The
   * suggested id is seeded into the picker as a labeled item (`seedItem`) so
   * an auto-filled value never renders as a bare shortcode before its label
   * has loaded via search. */
  suggestField?: string;
}) {
  const controlId = String(name);
  const descriptionId = `${controlId}-description`;
  // Called unconditionally regardless of `suggestField` — a no-op without a
  // mounted `FieldSuggestionProvider`, same as `AutoSuggestSlot`.
  const { suggestion, applied, isPending, apply, seedItem } =
    useAutoFieldSuggestion({
      form,
      name,
      field: suggestField ?? "",
      disabled: !suggestField,
    });
  return (
    <SearchProvider scope={scope}>
      {({ items, onSearchChange, isLoading, onCreateNew, onOpenChange }) => (
        <Controller
          control={form.control}
          name={name}
          render={({ field, fieldState }) => {
            const rawId = z.string().safeParse(field.value).data;
            const id = rawId ? parseShortcodeFor(entity, rawId) : null;
            const selected =
              items.find((item) => item.id === id) ??
              (id && seedItem?.id === id
                ? ({
                    ...seedItem,
                    id,
                  } satisfies ComboboxItem<ShortcodeFor<E>>)
                : id
                  ? ({ id, shortcode: id, name: id } satisfies ComboboxItem<
                      ShortcodeFor<E>
                    >)
                  : null);
            return (
              <FormFieldGroup
                htmlFor={controlId}
                label={label}
                description={description}
                descriptionId={descriptionId}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                <EntityPicker
                  inputId={controlId}
                  aria-describedby={description ? descriptionId : undefined}
                  entity={entity}
                  // The field label is the picker's accessible name ("Parent
                  // location", not "location") and names its clear button.
                  label={label ?? entity}
                  placeholder={placeholder}
                  items={items}
                  value={selected}
                  setValue={(item) =>
                    field.onChange(
                      // SAFETY: `name` is a caller-owned Path whose value is
                      // the selected entity shortcode; RHF cannot derive the
                      // relationship from this generic form type.
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
                {suggestField && (
                  <FieldSuggestionHint
                    suggestion={suggestion}
                    applied={applied}
                    pending={isPending}
                    onApply={apply}
                  />
                )}
              </FormFieldGroup>
            );
          }}
        />
      )}
    </SearchProvider>
  );
}
