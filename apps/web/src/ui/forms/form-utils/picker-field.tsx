import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  Controller,
  type FieldPathByValue,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
  useWatch,
} from "react-hook-form";
import { z } from "zod";

import { AutoSuggestControls } from "~/features/ai/auto-suggest-slot";
import {
  type UseAutoFieldSuggestionResult,
  useAutoFieldSuggestion,
} from "~/features/ai/use-auto-field-suggestion";
import type { ComboboxItem, PickerEntity } from "~/ui/combobox/combobox-types";
import type { EntitySearchScope } from "~/ui/combobox/entity-search-hooks";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { useSelectedPickerItems } from "~/ui/combobox/selected-items";
import type {
  EntitySearchResult,
  SearchProviderProps,
} from "~/ui/combobox/with-search-hook";
import {
  type VendorName,
  WithVendorSearch,
} from "~/ui/combobox/with-vendor-search";

import { FormFieldGroup } from "../form-field-group";

type SearchProvider = (props: SearchProviderProps<string>) => ReactNode;

interface PickerFieldBase<TFieldValues extends FieldValues> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label?: string;
  /** Keep the accessible name when a surrounding grid supplies the heading. */
  hideLabel?: boolean;
  placeholder?: string;
  description?: ReactNode;
  disabled?: boolean;
  /** The manifest target key this field suggests (e.g. `"trade"`,
   * `"locationId"`) — mounts the suggestion controls under the picker. */
  suggestField?: string;
}

/**
 * How the field stores its selection — each variant names its value, its
 * empty value, and where its candidates come from:
 *
 * - `option`: a `PickerOption.value` string; empty is `null` (a `nullable`
 *   field offers "None").
 * - `id`: a record's shortcode from an entity search; empty is `""` (bulk
 *   edit folds it into `null`).
 * - `item`: the whole picker row (recipe lines, whose aliases ride along);
 *   empty is `null`.
 * - `name`: a vendor's name, saved verbatim from the roster or typed as new;
 *   empty is `""`. The server resolves names through `findOrCreateVendor`.
 * - `ids`: a set of shortcodes, shown as removable chips; empty is `[]`.
 */
export type PickerFieldProps<TFieldValues extends FieldValues> =
  PickerFieldBase<TFieldValues> &
    (
      | {
          store: "option";
          options: readonly PickerOption[];
          nullable?: boolean;
          /** The empty choice's label on a `nullable` field. */
          noneLabel?: string;
          /** The roster is still loading (options read from a query). */
          isLoading?: boolean;
          /** Defaults to `choose` up to {@link CHOOSE_MODE_MAX} options and
           * `search` beyond. */
          mode?: "search" | "choose";
        }
      | {
          store: "id";
          entity: PickerEntity;
          SearchProvider: SearchProvider;
          /** Dependent-field filters for the candidates; `null` keeps the
           * picker scoped but idle. */
          scope?: EntitySearchScope | null;
          clearable?: boolean;
          /** Fires with the selected row (or null on clear) after the write. */
          onSelect?: (item: ComboboxItem | null) => void;
        }
      | ({
          store: "item";
          entity: PickerEntity;
          name: FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>;
          clearable?: boolean;
          onSelect?: (item: ComboboxItem | null) => void;
        } & Omit<EntitySearchResult<string>, "isLoading" | "onOpenChange"> & {
            isLoading?: boolean;
            onOpenChange?: (open: boolean) => void;
          })
      | { store: "name"; entity: "vendor" }
      | {
          store: "ids";
          entity: PickerEntity;
          SearchProvider: SearchProvider;
          scope?: EntitySearchScope | null;
        }
    );

/** Above this many options a typed filter beats scanning the list. */
const CHOOSE_MODE_MAX = 12;
const NONE = "__none__";

/** The one react-hook-form binding for a value picker. */
export function PickerField<TFieldValues extends FieldValues>(
  props: PickerFieldProps<TFieldValues>,
) {
  switch (props.store) {
    case "option":
      return <OptionPickerField {...props} />;
    case "id":
      return (
        <props.SearchProvider scope={props.scope}>
          {(search) => <RecordPickerField {...props} search={search} />}
        </props.SearchProvider>
      );
    case "item":
      return (
        <RecordPickerField
          {...props}
          clearable={props.clearable ?? true}
          search={{
            items: props.items,
            onSearchChange: props.onSearchChange,
            isLoading: props.isLoading ?? false,
            onCreateNew: props.onCreateNew,
            onOpenChange: props.onOpenChange ?? (() => {}),
          }}
        />
      );
    case "name":
      return (
        <WithVendorSearch>
          {(search) => <VendorNamePickerField {...props} search={search} />}
        </WithVendorSearch>
      );
    case "ids":
      return (
        <props.SearchProvider scope={props.scope}>
          {(search) => <MultiPickerField {...props} search={search} />}
        </props.SearchProvider>
      );
  }
}

function OptionPickerField<TFieldValues extends FieldValues>({
  form,
  name,
  label,
  hideLabel,
  options,
  placeholder,
  nullable = false,
  noneLabel = "None",
  isLoading,
  disabled = false,
  description,
  suggestField,
  mode,
}: PickerFieldBase<TFieldValues> & {
  options: readonly PickerOption[];
  nullable?: boolean;
  noneLabel?: string;
  isLoading?: boolean;
  mode?: "search" | "choose";
}) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  const suggestion = useAutoFieldSuggestion({
    form,
    name,
    field: suggestField ?? "",
    disabled: !suggestField,
  });
  const items = useMemo(
    () =>
      nullable ? [{ value: NONE, label: noneLabel }, ...options] : options,
    [nullable, noneLabel, options],
  );
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={controlId}
          label={label}
          hideLabel={hideLabel}
          description={description}
          descriptionId={descriptionId}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Picker
            mode={
              mode ?? (items.length > CHOOSE_MODE_MAX ? "search" : "choose")
            }
            inputId={controlId}
            inputRef={field.ref}
            options={items}
            isLoading={isLoading}
            value={field.value ?? (nullable ? NONE : null)}
            onOpenChange={(open) => {
              if (!open) field.onBlur();
            }}
            onValueChange={(value) => {
              field.onBlur();
              field.onChange(value === NONE ? null : value);
            }}
            placeholder={
              placeholder ??
              (label ? `Choose ${label.toLowerCase()}…` : undefined)
            }
            label={label}
            aria-describedby={description ? descriptionId : undefined}
            disabled={disabled}
          />
          {suggestField && (
            <AutoSuggestControls
              form={form}
              field={suggestField}
              result={suggestion}
              disabled={disabled}
            />
          )}
        </FormFieldGroup>
      )}
    />
  );
}

/** How a record field reads and writes its stored value. */
type StoredRecord = { id: string; item?: ComboboxItem };

interface RecordValueAdapter {
  valueKind: "id" | "item";
  read: (value: unknown, entity: PickerEntity) => StoredRecord | null;
  write: (item: ComboboxItem | null) => string | ComboboxItem | null;
}

const comboboxItemValue = z
  .object({ id: z.string(), name: z.string() })
  .passthrough();

const recordAdapters = {
  id: {
    valueKind: "id",
    read: (value, entity): StoredRecord | null =>
      typeof value === "string" && value
        ? { id: parseShortcodeFor(entity, value) }
        : null,
    write: (item) => item?.id ?? "",
  },
  item: {
    valueKind: "item",
    read: (value): StoredRecord | null => {
      const parsed = comboboxItemValue.safeParse(value);
      // SAFETY: an item-valued field only ever stores a picker row, which
      // the schema above proves carries the row's id and name.
      return parsed.success
        ? { id: parsed.data.id, item: parsed.data as ComboboxItem }
        : null;
    },
    write: (item) => item,
  },
} satisfies Record<"id" | "item", RecordValueAdapter>;

/**
 * The live suggestion's ranked candidates as full rows: the roster's own row
 * (with its picture) wherever it lists the candidate, resolved records
 * otherwise, each keeping its pinned "Suggested" presentation.
 */
function useSuggestedRows(
  entity: PickerEntity,
  suggestion: UseAutoFieldSuggestionResult,
  roster: readonly ComboboxItem[],
) {
  // Stable: the hook returns one shared empty array without a suggestion.
  const seeds = suggestion.seedItems;
  const merged = useMemo(() => {
    const byId = new Map(roster.map((item) => [item.id, item]));
    return seeds.map((seed) => {
      const row = byId.get(seed.id);
      return row ? { ...row, presentation: seed.presentation } : seed;
    });
  }, [roster, seeds]);
  return useSelectedPickerItems(
    entity,
    merged.map((item) => item.id),
    merged,
  );
}

function RecordPickerField<TFieldValues extends FieldValues>({
  form,
  name,
  entity,
  label,
  hideLabel,
  placeholder,
  description,
  disabled,
  clearable,
  suggestField,
  store,
  search,
  onSelect,
}: PickerFieldBase<TFieldValues> & {
  store: "id" | "item";
  entity: PickerEntity;
  clearable?: boolean;
  search: EntitySearchResult<string>;
  onSelect?: (item: ComboboxItem | null) => void;
}) {
  const adapter = recordAdapters[store];
  const controlId = String(name);
  const descriptionId = `${controlId}-description`;
  // The last picked (or created) row, so its picture survives searches that
  // no longer list it.
  const [lastSelected, setLastSelected] = useState<ComboboxItem | null>(null);
  const suggestion = useAutoFieldSuggestion({
    form,
    name,
    field: suggestField ?? "",
    valueKind: adapter.valueKind,
    disabled: !suggestField,
  });
  const suggested = useSuggestedRows(entity, suggestion, search.items);
  const suggestedIds = new Set(suggested.map((item) => item.id));
  const items = [
    ...suggested,
    ...search.items.filter((item) => !suggestedIds.has(item.id)),
  ];
  const stored = adapter.read(
    useWatch({ control: form.control, name }),
    entity,
  );
  const held = [
    ...(stored?.item ? [stored.item] : []),
    ...items,
    ...(lastSelected ? [lastSelected] : []),
  ];
  const [selected] = useSelectedPickerItems(
    entity,
    stored ? [stored.id] : [],
    held,
  );
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={controlId}
          label={label}
          hideLabel={hideLabel}
          description={description}
          descriptionId={descriptionId}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Picker
            inputId={controlId}
            inputRef={field.ref}
            aria-describedby={description ? descriptionId : undefined}
            entity={entity}
            // The field label is the picker's accessible name ("Parent
            // location", not "location") and names its clear button.
            label={label}
            placeholder={placeholder}
            items={items}
            value={selected ?? null}
            setValue={(item) => {
              if (item) setLastSelected(item);
              field.onBlur();
              field.onChange(
                // SAFETY: `name` is a caller-owned Path whose value is the
                // adapter's stored shape; RHF cannot derive that relationship
                // from this generic form type.
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
            disabled={disabled}
          />
          {suggestField && (
            <AutoSuggestControls
              form={form}
              field={suggestField}
              result={suggestion}
              currentLabel={selected?.pending ? undefined : selected?.name}
              disabled={disabled}
            />
          )}
        </FormFieldGroup>
      )}
    />
  );
}

/**
 * The expense vendor: a name-valued picker over the whole roster. Saving the
 * picked option's name verbatim keeps a typo from minting a duplicate vendor;
 * a genuinely new name still works through "Create vendor: …", which appears
 * only once the typed term matches nothing.
 */
function VendorNamePickerField<TFieldValues extends FieldValues>({
  form,
  name,
  label = "Vendor",
  placeholder = "Where from?",
  disabled,
  suggestField,
  search,
}: PickerFieldBase<TFieldValues> & { search: EntitySearchResult<VendorName> }) {
  const controlId = useId();
  const suggestion = useAutoFieldSuggestion({
    form,
    name,
    field: suggestField ?? "",
    disabled: !suggestField,
  });
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const vendor = String(field.value ?? "");
        const selected = vendor
          ? (search.items.find((item) => item.id === vendor) ?? {
              id: vendor,
              name: vendor,
            })
          : null;
        return (
          <FormFieldGroup
            htmlFor={controlId}
            label={label}
            invalid={fieldState.invalid}
            error={fieldState.error}
          >
            <Picker<VendorName>
              inputId={controlId}
              inputRef={field.ref}
              entity="vendor"
              label={label}
              placeholder={placeholder}
              items={search.items}
              onSearchChange={search.onSearchChange}
              isLoading={search.isLoading}
              value={selected}
              // An empty string is what the callers' `.trim() || null` turns
              // into a null vendor.
              setValue={(item) => {
                field.onBlur();
                field.onChange(
                  // SAFETY: `name` is a caller-owned Path whose value is the
                  // vendor-name string.
                  (item?.id ?? "") as PathValue<
                    TFieldValues,
                    Path<TFieldValues>
                  >,
                );
              }}
              onCreateNew={search.onCreateNew}
              onOpenChange={(open) => {
                if (!open) field.onBlur();
                search.onOpenChange(open);
              }}
              clearable
              disabled={disabled}
            />
            {suggestField && (
              <AutoSuggestControls
                form={form}
                field={suggestField}
                result={suggestion}
                disabled={disabled}
              />
            )}
          </FormFieldGroup>
        );
      }}
    />
  );
}

const idList = z.array(z.string()).catch([]);

/**
 * A multi-reference field whose stored value is the full id set
 * (`blockedByIds`, `candidateProductIds`): one multiple picker whose chips
 * resolve every id to its record — including ids outside the current
 * candidate scope.
 */
function MultiPickerField<TFieldValues extends FieldValues>({
  form,
  name,
  entity,
  label,
  disabled,
  search,
}: PickerFieldBase<TFieldValues> & {
  entity: PickerEntity;
  search: EntitySearchResult<string>;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={String(name)}
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Picker
            multiple
            inputId={String(name)}
            inputRef={field.ref}
            entity={entity}
            label={label}
            items={search.items}
            values={idList.parse(field.value).map((id) => ({ id, name: id }))}
            setValues={(items) =>
              field.onChange(
                // SAFETY: `name` is a caller-owned Path whose value is the
                // selected id list.
                items.map((item) => item.id) as PathValue<
                  TFieldValues,
                  Path<TFieldValues>
                >,
              )
            }
            onSearchChange={search.onSearchChange}
            isLoading={search.isLoading}
            onOpenChange={(open) => {
              if (!open) field.onBlur();
              search.onOpenChange(open);
            }}
            disabled={disabled}
          />
        </FormFieldGroup>
      )}
    />
  );
}
