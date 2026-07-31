import type React from "react";
import { useMemo } from "react";
import type { ComboboxItem } from "./combobox-types";
import { EntityPicker } from "./entity-picker";

interface StaticPickerOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  color?: string;
}

interface StaticPickerProps {
  items: readonly StaticPickerOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  clearable?: boolean;
}

/** String-valued form adapter for the shared Base UI picker shell. */
export function StaticPicker({
  items,
  value,
  onValueChange,
  label,
  placeholder,
  className,
  disabled,
  autoFocus,
  compact,
  clearable,
}: StaticPickerProps) {
  const pickerItems = useMemo<ComboboxItem[]>(
    () =>
      items.map((item) => ({
        id: item.value,
        name: item.label,
        icon: item.icon,
        color: item.color,
      })),
    [items],
  );
  const selected =
    pickerItems.find((item) => item.id === value) ??
    (value ? { id: value, name: value } : null);

  return (
    <div className={className}>
      <EntityPicker
        label={label}
        items={pickerItems}
        value={selected}
        setValue={(item) => onValueChange(item?.id ?? null)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        compact={compact}
        clearable={clearable}
      />
    </div>
  );
}
