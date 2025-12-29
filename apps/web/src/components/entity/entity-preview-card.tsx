import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { MobileCard } from "./mobile-card";

// Type-safe route patterns
type RoutePattern =
  | { to: "/products/$id"; params: { id: string } }
  | { to: "/locations/$id"; params: { id: string } }
  | { to: "/inventory/$id"; params: { id: string } }
  | { to: "/recipes/$id"; params: { id: string } }
  | { to: "/ingredients/$id"; params: { id: string } }
  | { to: "/images/$id"; params: { id: string } };

interface EntityPreviewCardProps {
  title: string;
  titleIcon?: LucideIcon;
  image?: ReactNode;
  subtitle?: string;
  badges?: ReactNode[];
  details?: ReactNode[];
  footer?: ReactNode;
  primaryAction?: {
    route?: RoutePattern;
    onClick?: () => void;
    label?: string;
    icon?: LucideIcon;
  };
  secondaryActions?: ReactNode;
  className?: string;
  variant?: "default" | "compact";
  onClick?: () => void;
}

/**
 * A convenience wrapper around MobileCard that provides structured props
 * for common entity preview patterns (title, image, badges, details, actions).
 *
 * Use this when you have structured content to display.
 * Use MobileCard directly when you need custom children or selection.
 */
export function EntityPreviewCard({
  title,
  titleIcon: TitleIcon,
  image,
  subtitle,
  badges = [],
  details = [],
  footer,
  primaryAction,
  secondaryActions,
  className,
  variant = "default",
  onClick,
}: EntityPreviewCardProps) {
  const isCompact = variant === "compact";

  // Build primary action button
  const renderPrimaryAction = () => {
    if (!primaryAction) return null;

    const actionButton = (
      <Button variant="outline" size="sm" onClick={primaryAction.onClick}>
        {primaryAction.icon && (
          <primaryAction.icon
            className={cn("mr-1 h-4 w-4", isCompact && "h-3 w-3")}
          />
        )}
        {primaryAction.label || "Edit"}
      </Button>
    );

    return primaryAction.route ? (
      <Link
        to={primaryAction.route.to as "/products/$id"}
        params={primaryAction.route.params as { id: string }}
      >
        {actionButton}
      </Link>
    ) : primaryAction.onClick ? (
      actionButton
    ) : null;
  };

  // Build actions element for MobileCard
  const actionsElement =
    primaryAction || secondaryActions ? (
      <div className={cn("flex gap-2", isCompact && "gap-1")}>
        {renderPrimaryAction()}
        {secondaryActions}
      </div>
    ) : undefined;

  return (
    <MobileCard
      onClick={onClick}
      actions={actionsElement}
      className={cn(
        // Override MobileCard's default left accent with plain border
        "border-l border-l-border",
        isCompact ? "p-3" : "p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {/* Image */}
        {image && <div className="shrink-0">{image}</div>}

        {/* Main Content */}
        <div
          className={cn("min-w-0 flex-1 space-y-2", isCompact && "space-y-1")}
        >
          {/* Title and Subtitle */}
          <div>
            <h5
              className={cn(
                "flex items-center gap-2 font-medium",
                isCompact && "text-sm",
              )}
            >
              {TitleIcon && (
                <TitleIcon className={cn("h-4 w-4", isCompact && "h-3 w-3")} />
              )}
              <span className="truncate">{title}</span>
            </h5>
            {subtitle && (
              <p
                className={cn(
                  "text-muted-foreground",
                  isCompact ? "text-xs" : "text-sm",
                )}
              >
                {subtitle}
              </p>
            )}
          </div>

          {/* Details */}
          {details.length > 0 && (
            <div className={cn("space-y-1", isCompact && "space-y-0.5")}>
              {details}
            </div>
          )}

          {/* Badges */}
          {badges.length > 0 && (
            <div className={cn("flex flex-wrap gap-2", isCompact && "gap-1")}>
              {badges}
            </div>
          )}

          {/* Footer */}
          {footer && (
            <div className={cn("border-t pt-2", isCompact && "pt-1")}>
              {footer}
            </div>
          )}
        </div>
      </div>
    </MobileCard>
  );
}
