import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The shared nivo/chart tooltip surface. Porcelain separation uses a hairline
 * `ring-1 ring-border` on `bg-popover`; it owns the surface so padding, size,
 * and elevation cannot drift across the 12+ chart call sites.
 *
 * This component deliberately stays in normal flow: nivo owns cursor tracking,
 * measurement, and edge flipping in the wrapper around this surface.
 */
export function ChartTooltip({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "rounded-md bg-popover px-4 py-2 text-sm ring-1 ring-border",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
