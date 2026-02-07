import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { entities } from "~/entities/entities";
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
  /** Optional image/thumbnail to render left of the title */
  imageSlot?: ReactNode;
  /** Optional entity type for colored accent border */
  entity?: Entity;
  /** Optional click handler for the entire card */
  onClick?: () => void;
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
  imageSlot,
  entity,
  onClick,
}: MobileCardProps) {
  // Get entity-specific border color, fallback to primary
  const borderColor = entity
    ? entities[entity].color.text.replace("text-", "border-l-")
    : "border-l-primary/30";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: role, tabIndex, and onKeyDown are conditionally set based on onClick
    <div
      className={cn(
        "fade-in flex animate-in items-start gap-3 rounded-lg border border-l-4 bg-card p-3 shadow-sm transition-all duration-300 hover:shadow-md",
        borderColor,
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
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
        {/* Header row: image + title + actions together */}
        {(title || detailsHref || actions) && (
          <div className="flex items-start gap-2">
            {imageSlot}
            {/* Title section */}
            {title && (
              <div className="min-w-0 flex-1">
                <h5 className="flex min-w-0 items-start gap-2 font-medium">
                  {TitleIcon && (
                    <TitleIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="line-clamp-2" title={title}>
                    {title}
                  </span>
                </h5>
                {subtitle && (
                  <p className="truncate text-muted-foreground text-sm">
                    {subtitle}
                  </p>
                )}
              </div>
            )}
            {/* Actions - compact, next to title */}
            {(detailsHref || actions) && (
              <div className="flex shrink-0 items-center gap-1">
                {detailsHref && (
                  <Link
                    to={detailsHref}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="View details"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                )}
                {actions}
              </div>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
