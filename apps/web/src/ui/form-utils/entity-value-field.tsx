import {
  parseShortcodeFor,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import { useState, type ReactNode } from "react";
import {
  Controller,
  type FieldPathByValue,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";

import { AutoSuggestHint } from "~/features/ai/auto-suggest-slot";
import { useAutoFieldSuggestion } from "~/features/ai/use-auto-field-suggestion";

import type { ComboboxItem, PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
import type { EntitySearchScope } from "../combobox/entity-search-hooks";
import type {
  EntitySearchResult,
  SearchProviderProps,
} from "../combobox/with-search-hook";
import { FormFieldGroup } from "../forms/form-field-group";

/**
 * How a picker form field stores its selection. The id adapter stores the
 * shortcode (assignment forms); the item adapter stores the whole picker item
 * (recipe rows, whose aliases ride along with the selection).
 */
interface PickerValueAdapter<TStored> {
  /** The write shape `useAutoFieldSuggestion` uses for this field. */
  valueKind: "id" | "item";
  /** The stored value's id, plus the item itself when the value is one. */
  read: (
    value: TStored,
    entity: PickerEntity,
  ) => { id: string; item?: ComboboxItem } | null;
  write: (item: ComboboxItem | null) => TStored;
  /** The picker's accessible name when the field has no label. */
  unlabeled: (entity: PickerEntity) => string;
}

const idValue: PickerValueAdapter<string | null | undefined> = {
  valueKind: "id",
  read: (value, entity) =>
    value ? { id: parseShortcodeFor(entity, value) } : null,
  // "" is this adapter's "no selection"; bulk edit folds it into null.
  write: (item) => item?.id ?? "",
  unlabeled: (entity) => entity,
};

const itemValue: PickerValueAdapter<ComboboxItem | null | undefined> = {
  valueKind: "item",
  read: (value) => (value ? { id: value.id, item: value } : null),
  write: (item) => item,
  unlabeled: () => "item",
};

type EntityPickerFieldProps<TFieldValues extends FieldValues> = {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  entity: PickerEntity;
  label?: string;
  placeholder?: string;
  description?: ReactNode;
  clearable?: boolean;
  /** The manifest target key this field suggests (e.g. `"locationId"`). */
  suggestField?: string;
  /** Fires with the selected item (or null on clear), after the field updates. */
  onSelect?: (item: ComboboxItem | null) => void;
};

/**
 * The one React Hook Form binding for an entity picker: label, description
 * and validation display, blur on selection and close, the pinned
 * "Suggested" candidates, and the selected item's label. The adapter decides
 * only what the field stores.
 *
 * An id-valued field keeps the last item it selected (or created), so its
 * label survives search results that no longer list it.
 */
function EntityPickerField<TFieldValues extends FieldValues, TStored>({
  form,
  name,
  entity,
  label,
  placeholder,
  description,
  clearable,
  suggestField,
  onSelect,
  search,
  adapter,
}: EntityPickerFieldProps<TFieldValues> & {
  search: EntitySearchResult<string>;
  adapter: PickerValueAdapter<TStored>;
}) {
  const controlId = String(name);
  const descriptionId = `${controlId}-description`;
  const [lastSelected, setLastSelected] = useState<ComboboxItem | null>(null);
  // Called unconditionally regardless of `suggestField` — a no-op without a
  // mounted `FieldSuggestionProvider`, same as `AutoSuggestSlot`.
  const suggestion = useAutoFieldSuggestion({
    form,
    name,
    field: suggestField ?? "",
    valueKind: adapter.valueKind,
    disabled: !suggestField,
  });
  // Pinned "Suggested" section ahead of the roster, only while there is a
  // live suggestion to show — an id the roster also lists is shown once,
  // under "Suggested", not twice.
  const suggestedIds = new Set(suggestion.seedItems.map((item) => item.id));
  const items = suggestion.suggestion
    ? [
        ...suggestion.seedItems,
        ...search.items.filter((item) => !suggestedIds.has(item.id)),
      ]
    : search.items;
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        // SAFETY: `name` is a caller-owned Path whose value is the adapter's
        // stored shape (the adapters write only that shape); RHF cannot
        // derive the relationship from this generic form type.
        const stored = adapter.read(field.value as TStored, entity);
        const selected = stored
          ? (stored.item ??
            items.find((item) => item.id === stored.id) ??
            [lastSelected, suggestion.seedItem].find(
              (item) => item?.id === stored.id,
            ) ?? { id: stored.id, shortcode: stored.id, name: stored.id })
          : null;
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
              inputRef={field.ref}
              aria-describedby={description ? descriptionId : undefined}
              entity={entity}
              // The field label is the picker's accessible name ("Parent
              // location", not "location") and names its clear button.
              label={label ?? adapter.unlabeled(entity)}
              placeholder={placeholder}
              items={items}
              value={selected}
              setValue={(item) => {
                if (item) setLastSelected(item);
                field.onBlur();
                field.onChange(
                  // SAFETY: the same stored-shape contract as the read above.
                  adapter.write(item) as PathValue<
                    TFieldValues,
                    Path<TFieldValues>
                  >,
                );
                onSelect?.(item);
              }}
              onSearchChange={search.onSearchChange}
              isLoading={search.isLoading}
              onCreateNew={search.onCreateNew}
              onOpenChange={(open) => {
                if (!open) field.onBlur();
                search.onOpenChange(open);
              }}
              clearable={clearable}
            />
            {suggestField && (
              <AutoSuggestHint
                field={suggestField}
                result={suggestion}
                currentLabel={selected?.name}
              />
            )}
          </FormFieldGroup>
        );
      }}
    />
  );
}

/** React Hook Form adapter for assignments whose persisted value is the id. */
export function EntityValueField<
  TFieldValues extends FieldValues,
  E extends PickerEntity,
>({
  SearchProvider,
  scope,
  entity,
  ...field
}: EntityPickerFieldProps<TFieldValues> & {
  entity: E;
  SearchProvider: (props: SearchProviderProps<ShortcodeFor<E>>) => ReactNode;
  /** Dependent-field filters for the candidate picker; null keeps it scoped but idle. */
  scope?: EntitySearchScope | null;
}) {
  return (
    <SearchProvider scope={scope}>
      {(search) => (
        <EntityPickerField
          {...field}
          entity={entity}
          search={search}
          adapter={idValue}
        />
      )}
    </SearchProvider>
  );
}

/** React Hook Form adapter for a picker whose form value is the whole item
 * (a recipe row's ingredient, with the aliases its drift check reads). */
export function EntityItemField<TFieldValues extends FieldValues>({
  name,
  items,
  onSearchChange,
  isLoading = false,
  onCreateNew,
  onOpenChange = () => {},
  clearable = true,
  ...field
}: Omit<EntityPickerFieldProps<TFieldValues>, "name"> &
  Omit<EntitySearchResult<string>, "isLoading" | "onOpenChange"> & {
    name: FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>;
    isLoading?: boolean;
    // Forwarded to the combobox so an async-search wrapper can defer its
    // options query until the dropdown opens.
    onOpenChange?: (open: boolean) => void;
  }) {
  return (
    <EntityPickerField
      {...field}
      name={name}
      clearable={clearable}
      search={{ items, onSearchChange, isLoading, onCreateNew, onOpenChange }}
      adapter={itemValue}
    />
  );
}
