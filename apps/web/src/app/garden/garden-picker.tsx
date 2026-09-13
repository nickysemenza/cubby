import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { Stack } from "~/components/layout";

export function GardenPicker({
  entity,
  label,
  value,
  onChange,
}: {
  entity: "ingredient" | "product" | "location";
  label: string;
  value: ComboboxItem | null;
  onChange: (value: ComboboxItem | null) => void;
}) {
  return (
    <Stack gap="sm">
      <span className="text-sm font-medium">{label}</span>
      <WithEntitySearch entity={entity}>
        {(search) => (
          <EntityPicker
            {...search}
            entity={entity}
            label={label}
            value={value}
            setValue={onChange}
            clearable
          />
        )}
      </WithEntitySearch>
    </Stack>
  );
}
