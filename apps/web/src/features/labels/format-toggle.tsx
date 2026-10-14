import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";

type LabelFormat = "pls134" | "pls763" | "ptouch";

const FORMAT_OPTIONS: readonly (PickerOption & { value: LabelFormat })[] = [
  { value: "pls134", label: '4 × 1.5"' },
  { value: "pls763", label: '2⅝ × 1"' },
  { value: "ptouch", label: "P-Touch" },
];

export function FormatToggle({
  format,
  onChange,
}: {
  format: LabelFormat;
  onChange: (format: LabelFormat) => void;
}) {
  return (
    <Picker
      mode="segmented"
      label="Label format"
      options={FORMAT_OPTIONS}
      value={format}
      onValueChange={(value) => {
        const choice = FORMAT_OPTIONS.find((option) => option.value === value);
        if (choice) onChange(choice.value);
      }}
    />
  );
}
