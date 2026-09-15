import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { Stack } from "~/components/layout";
import { Label } from "~/components/ui/label";

import { garden } from "./garden.functions";

type GardenPickerEntity = "ingredient" | "product" | "location";

/** Maps a picker entity to its bucket in `gardenOptionsOut`. */
const optionsKeyFor = {
  ingredient: "ingredients",
  product: "products",
  location: "locations",
} as const satisfies Record<GardenPickerEntity, string>;

/**
 * Defaults to the garden-scoped roster from `garden.options` (crops and
 * locations already relevant to the garden) and widens to a name-prefix
 * search across the household the moment the user types 2+ characters —
 * `EntityPicker` already debounces `onSearchChange` — so an out-of-scope
 * crop or location stays reachable without abandoning the scoped default.
 */
export function GardenPicker({
  entity,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  required,
  loadOptions = garden.options,
}: {
  entity: GardenPickerEntity;
  label: string;
  value: ComboboxItem | null;
  onChange: (value: ComboboxItem | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Visible affordance only — the actual constraint is the caller disabling submit. */
  required?: boolean;
  loadOptions?: typeof garden.options;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const options = useQuery(loadOptions.queryOptions(search ? { search } : {}));
  const rows = options.data?.[optionsKeyFor[entity]] ?? [];
  const items: ComboboxItem[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
  }));
  return (
    <Stack gap="sm">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        )}
      </Label>
      {/* `WithEntitySearch` is used only for its create-from-picker dialog
          (a brand-new crop or growing area typed straight into the field);
          the item source stays the garden-scoped roster above. */}
      <WithEntitySearch entity={entity}>
        {(search) => (
          <EntityPicker
            inputId={id}
            entity={entity}
            label={label}
            items={items}
            value={value}
            setValue={onChange}
            onSearchChange={(query) => {
              setSearch(query);
              search.onSearchChange(query);
            }}
            onCreateNew={search.onCreateNew}
            isLoading={options.isPending}
            placeholder={placeholder}
            clearable
            disabled={disabled}
          />
        )}
      </WithEntitySearch>
    </Stack>
  );
}
