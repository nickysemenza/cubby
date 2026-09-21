import type { LucideIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

interface ChoiceSwitcherOption<T extends string = string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

interface ChoiceSwitcherProps<T extends string> {
  options: readonly ChoiceSwitcherOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  ariaLabel: string;
  /** Keep the complete labels accessible while using icon-only phone chrome. */
  compactOnMobile?: boolean;
  optionAriaLabel?: (option: ChoiceSwitcherOption<T>) => string;
}

/**
 * Canonical single-choice segmented control. Presentational + controlled — the
 * caller owns whether the choice changes a view, filter, basis, or format.
 */
export function ChoiceSwitcher<T extends string>({
  options,
  value,
  onValueChange,
  className,
  ariaLabel,
  compactOnMobile = false,
  optionAriaLabel = (option) => option.label,
}: ChoiceSwitcherProps<T>) {
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
            aria-label={optionAriaLabel(opt)}
            // Phone-only touch floor. DESIGN.md keeps desktop controls compact
            // (28px) but requires 40–48px on phones, and the `sm` toggle size
            // is 24px — well under half a finger.
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
          >
            {/* Icon-only below md (touch, no room for the label); text-only at
                md+ — the band's segmented views read as words on desktop, not
                a row of unlabelled glyphs. */}
            {Icon && (
              <Icon
                className={cn("size-4", compactOnMobile ? "mr-2 md:hidden" : "mr-2")}
              />
            )}
            <span
              className={cn(compactOnMobile && Icon && "max-md:sr-only")}
            >
              {opt.label}
            </span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

export type ViewSwitcherOption<T extends string = string> =
  ChoiceSwitcherOption<T>;

/** View-specific name retained for the dominant renderer-switching use case. */
export function ViewSwitcher<T extends string>(
  props: Omit<ChoiceSwitcherProps<T>, "ariaLabel" | "optionAriaLabel"> & {
    ariaLabel?: string;
  },
) {
  return (
    <ChoiceSwitcher
      {...props}
      ariaLabel={props.ariaLabel ?? "Switch view"}
      optionAriaLabel={(option) => `${option.label} view`}
    />
  );
}
