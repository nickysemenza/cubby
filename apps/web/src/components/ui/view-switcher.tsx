import type { LucideIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

export interface ViewSwitcherOption<T extends string = string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

interface ViewSwitcherProps<T extends string> {
  options: ViewSwitcherOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  /** Accessible label for the switcher group. */
  ariaLabel?: string;
}

/**
 * Single, consistent control for switching how the same data is displayed
 * (e.g. recipe Magazine/NYT/Table/Charts, locations Gallery/Table/Visualizations).
 * Presentational + controlled — the caller owns the state (local or URL) and
 * renders the view content itself.
 */
export function ViewSwitcher<T extends string>({
  options,
  value,
  onValueChange,
  className,
  ariaLabel = "Switch view",
}: ViewSwitcherProps<T>) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={cn("w-fit", className)}
      variant="outline"
      size="sm"
      value={[value]}
      onValueChange={(values: string[]) => {
        const next = values[0] as T | undefined;
        if (next) onValueChange(next);
      }}
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        return (
          <ToggleGroupItem
            key={opt.value}
            value={opt.value}
            aria-label={`${opt.label} view`}
          >
            {Icon && <Icon className="mr-2 size-4" />}
            {opt.label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
