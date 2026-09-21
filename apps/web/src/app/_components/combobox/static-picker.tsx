import type React from "react";
import { useMemo } from "react";

import { colorizeSelectOptions } from "~/lib/select-options";

import type { ComboboxItem } from "./combobox-types";
import { EntityPicker } from "./entity-picker";

interface StaticPickerOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  color?: string;
}

interface StaticPickerProps {
  inputId?: string;
  "aria-describedby"?: string;
  items: readonly StaticPickerOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  onOpenChange?: (open: boolean) => void;
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  openOnMount?: boolean;
  compact?: boolean;
  clearable?: boolean;
  widthMode?: "default" | "intrinsic";
}

/** String-valued form adapter for the shared Base UI picker shell. */
export function StaticPicker({
  inputId,
  "aria-describedby": ariaDescribedBy,
  items,
  value,
  onValueChange,
  onOpenChange,
  label,
  placeholder,
  className,
  disabled,
  openOnMount,
  compact,
  clearable,
  widthMode,
}: StaticPickerProps) {
  const pickerItems = useMemo<ComboboxItem[]>(
    () =>
      colorizeSelectOptions(items).map((item) => ({
        id: item.value,
        name: item.label,
        icon: item.icon ? (
          <span
            aria-hidden
            data-enum-option-icon=""
            className="flex items-center [&>svg]:size-3.5!"
            style={{ color: item.color }}
          >
            {item.icon}
          </span>
        ) : undefined,
        color: item.icon ? undefined : item.color,
      })),
    [items],
  );
  const selected =
    pickerItems.find((item) => item.id === value) ??
    (value ? { id: value, name: value } : null);

  return (
    <div className={className}>
      <EntityPicker
        inputId={inputId}
        aria-describedby={ariaDescribedBy}
        label={label}
        items={pickerItems}
        value={selected}
        setValue={(item) => onValueChange(item?.id ?? null)}
        onOpenChange={onOpenChange}
        placeholder={placeholder}
        disabled={disabled}
        openOnMount={openOnMount}
        compact={compact}
        clearable={clearable}
        widthMode={widthMode}
      />
    </div>
  );
}
