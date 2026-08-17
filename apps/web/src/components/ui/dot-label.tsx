import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * A taxonomy label rendered as a small mark + plain text. Dense lists read as
 * text with a quiet colour cue rather than a wall of chips. Inherits font size
 * from its context (table cell density, detail fact sheet, etc.).
 *
 * The mark is a colour dot by default, or `icon` when the taxonomy already has
 * a glyph worth more than a swatch — a trade's tool glyph distinguishes 19
 * values no colour ramp could, and a product category's icon is already tinted
 * with the very colour the dot would have carried.
 */
export function DotLabel({
  color,
  icon,
  children,
  className,
}: {
  /** Any CSS color for the dot (e.g. an oklch from the category/location map). */
  color?: string;
  /** Replaces the dot. Size it at the call site (`size-3.5` for inline glyphs). */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {icon ? (
        <span aria-hidden className="flex shrink-0 items-center">
          {icon}
        </span>
      ) : (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
