"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface EntityPreviewCardProps {
  title: string;
  titleIcon?: LucideIcon;
  image?: ReactNode;
  subtitle?: string;
  badges?: ReactNode[];
  details?: ReactNode[];
  footer?: ReactNode;
  primaryAction?: {
    href?: string;
    onClick?: () => void;
    label?: string;
    icon?: LucideIcon;
  };
  secondaryActions?: ReactNode;
  className?: string;
  variant?: "default" | "compact";
  onClick?: () => void;
}

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

    return primaryAction.href ? (
      <Link href={primaryAction.href}>{actionButton}</Link>
    ) : primaryAction.onClick ? (
      actionButton
    ) : null;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && onClick) {
      e.preventDefault();
      onClick();
    }
  };

  // Only add interactive attributes when onClick is provided
  const interactiveProps = onClick
    ? {
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: handleKeyDown,
        onClick: onClick,
      }
    : {};

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        isCompact ? "p-3" : "p-4",
        onClick && "cursor-pointer hover:bg-gray-50",
        className,
      )}
      {...interactiveProps}
    >
      <div className="flex items-start justify-between">
        {/* Image and Content */}
        <div className={cn("flex items-start gap-3", !image && "flex-1")}>
          {/* Image */}
          {image && <div className="flex-shrink-0">{image}</div>}

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
                  <TitleIcon
                    className={cn("h-4 w-4", isCompact && "h-3 w-3")}
                  />
                )}
                <span className="truncate">{title}</span>
              </h5>
              {subtitle && (
                <p
                  className={cn(
                    "text-gray-600",
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

        {/* Actions */}
        {(primaryAction || secondaryActions) && (
          <div className={cn("flex gap-2", isCompact && "gap-1")}>
            {renderPrimaryAction()}
            {secondaryActions}
          </div>
        )}
      </div>
    </div>
  );
}
