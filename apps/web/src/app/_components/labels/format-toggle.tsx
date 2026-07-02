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
    <div className="flex rounded-md border border-[var(--border)]">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`px-2 py-2 text-sm transition-colors ${
            format === opt.value
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted"
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
