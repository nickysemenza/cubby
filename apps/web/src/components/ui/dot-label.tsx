import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * A taxonomy label rendered as a small colored dot + plain text. Dense lists
 * read as text with a quiet color cue rather than a wall of chips. Inherits
 * font size from its context (table cell density, detail fact sheet, etc.).
 */
export function DotLabel({
  color,
  children,
  className,
}: {
  /** Any CSS color for the dot (e.g. an oklch from the category/location map). */
  color: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
