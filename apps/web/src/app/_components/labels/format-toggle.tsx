import { ChoiceSwitcher } from "~/components/ui/view-switcher";

export function FormatToggle({
  format,
  onChange,
}: {
  format: "pls134" | "pls763" | "ptouch";
  onChange: (format: "pls134" | "pls763" | "ptouch") => void;
}) {
  const options = [
    { value: "pls134" as const, label: '4 × 1.5"' },
    { value: "pls763" as const, label: '2⅝ × 1"' },
    { value: "ptouch" as const, label: "P-Touch" },
  ];
  return (
    <ChoiceSwitcher
      ariaLabel="Label format"
      options={options}
      value={format}
      onValueChange={onChange}
    />
  );
}
