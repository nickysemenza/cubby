import { Link } from "@tanstack/react-router";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
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
  /** Optional link to details page - renders a visible view button */
  detailsHref?: string;
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
  detailsHref,
  title,
  titleIcon: TitleIcon,
  subtitle,
}: MobileCardProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-l-2 border-l-primary/30 bg-card p-3 shadow-sm transition-shadow hover:shadow-md",
        className,
      )}
    >
      {/* Checkbox - only rendered if selectable */}
      {selectable && (
        <Checkbox
          checked={selectable.isSelected}
          onCheckedChange={(checked) => selectable.onSelectionChange(!!checked)}
          className="mt-1"
          aria-label="Select item"
        />
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

      {/* View button and actions */}
      {(detailsHref || actions) && (
        <div className="flex shrink-0 items-center gap-1">
          {detailsHref && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <Link to={detailsHref}>
                <ChevronRight className="h-4 w-4" />
                <span className="sr-only">View details</span>
              </Link>
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
