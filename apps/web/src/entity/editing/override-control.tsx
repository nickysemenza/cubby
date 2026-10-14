import type { ReactNode } from "react";

import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";

/** The owning field supplies its allowed states; the control adds no null semantics. */
export function OverrideControl({
  label,
  value,
  options,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string;
  options: readonly PickerOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Picker
        mode="choose"
        className="w-48"
        label={label}
        options={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next != null) onChange(next);
        }}
      />
      {children}
    </div>
  );
}
