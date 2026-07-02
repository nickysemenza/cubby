import type { CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The shared nivo/chart tooltip surface. Warm-Paper Ledger separation idiom:
 * a hairline `ring-1 ring-border` on `bg-popover`, no shadow — the ring reads
 * as the ledger rule that lifts the tooltip off the chart. Owns the surface so
 * padding/size/elevation can't drift across the 12+ chart call sites.
 *
 * Pass `className` for per-site needs (e.g. the positioned overlay in
 * location-treemap); a later class wins via twMerge.
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
