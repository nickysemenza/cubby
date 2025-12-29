import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";

interface MobileCardProps {
  /** Optional selection state - omit for non-selectable cards */
  selectable?: {
    isSelected: boolean;
    onSelectionChange: (checked: boolean) => void;
  };
  /** Optional actions element (typically a dropdown menu) */
  actions?: ReactNode;
  /** Main content of the card */
  children?: ReactNode;
  /** Additional className for the card container */
  className?: string;
  /** Optional click handler for the card (for navigation) */
  onClick?: () => void;
  /** Optional title - renders structured header when provided */
  title?: string;
  /** Optional icon for title */
  titleIcon?: LucideIcon;
  /** Optional subtitle below title */
  subtitle?: string;
}

/**
 * A mobile-friendly card component with optional selection checkbox.
 * Provides consistent layout: [Checkbox] | Content | [Actions]
 *
 * Supports two modes:
 * - Structured: Pass title/subtitle props for automatic header rendering
 * - Flexible: Pass children for full control over content
 *
 * Used by:
 * - MobileCardView for entity lists (with optional selection)
 * - LocationInventoryTable for inventory items with inline editing
 * - ProblemSection and LocationCardGrid for entity previews
 */
export function MobileCard({
  selectable,
  actions,
  children,
  className,
  onClick,
  title,
  titleIcon: TitleIcon,
  subtitle,
}: MobileCardProps) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: role/tabIndex only added when onClick present
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-l-2 border-l-primary/30 bg-card p-3 shadow-sm transition-shadow hover:shadow-md",
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {/* Checkbox - only rendered if selectable, stops propagation */}
      {selectable && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selectable.isSelected}
            onCheckedChange={(checked) =>
              selectable.onSelectionChange(!!checked)
            }
            className="mt-1"
            aria-label="Select item"
          />
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1 space-y-2">
        {/* Structured header when title is provided */}
        {title && (
          <div>
            <h5 className="flex items-center gap-2 font-medium">
              {TitleIcon && <TitleIcon className="h-4 w-4" />}
              <span className="truncate">{title}</span>
            </h5>
            {subtitle && (
              <p className="text-muted-foreground text-sm">{subtitle}</p>
            )}
          </div>
        )}
        {children}
      </div>

      {/* Actions - stops propagation to prevent triggering card onClick */}
      {actions && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper
        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
