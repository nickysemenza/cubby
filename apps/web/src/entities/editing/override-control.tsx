import type { ReactNode } from "react";

import { NativeSelect } from "~/components/ui/native-select";

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
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      {children}
    </div>
  );
}
