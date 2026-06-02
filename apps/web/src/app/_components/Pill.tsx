import type React from "react";
import { cn } from "~/lib/utils";

/** Base className for pill styling - use for custom pill-like elements (e.g., Links) */
export const pillClassName =
  "group inline-flex items-center gap-1 rounded border border-border/50 px-1 py-px text-xs";

interface PillProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  metadata?: string;
  color?: string; // HSL color for tinted background
  /** Truncate long text with max-width */
  compact?: boolean;
  className?: string;
}

export function Pill({
  icon,
  children,
  metadata,
  color,
  compact,
  className,
}: PillProps) {
  return (
    <span
      className={cn(pillClassName, className)}
      style={
        color
          ? { backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }
          : undefined
      }
    >
      {icon && (
        <span className="shrink-0 transition-transform duration-150 ease-cozy group-hover:rotate-3 group-hover:scale-110">
          {icon}
        </span>
      )}
      <span className={cn("min-w-0", compact && "max-w-32 truncate")}>
        {children}
      </span>
      {metadata && (
        <>
          <span className="shrink-0 text-muted-foreground/40">|</span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {metadata}
          </span>
        </>
      )}
    </span>
  );
}
