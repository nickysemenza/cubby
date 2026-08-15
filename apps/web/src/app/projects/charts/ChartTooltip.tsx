import type { ExpenseOut } from "@cubby/schemas/project";
import type { CSSProperties, ReactNode } from "react";
import { cn, formatCurrency } from "~/lib/utils";

/**
 * The shared nivo/chart tooltip surface. Warm-Paper Ledger separation idiom:
 * a hairline `ring-1 ring-border` on `bg-popover`, no shadow — the ring reads
 * as the ledger rule that lifts the tooltip off the chart. Owns the surface so
 * padding/size/elevation can't drift across the 12+ chart call sites.
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

/**
 * The top 3 expenses behind a donut slice / bar segment (by cost desc) with a
 * "+N more" roll-up — a shared breakdown row-list for the nivo tooltips.
 */
export function TooltipExpenseBreakdown({
  expenses,
}: {
  expenses: ExpenseOut[];
}) {
  if (expenses.length === 0) return null;
  const sorted = [...expenses].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  const top = sorted.slice(0, 3);
  const remaining = sorted.length - top.length;

  return (
    <div className="mt-1 space-y-1 border-border/60 border-t pt-1 text-muted-foreground text-xs">
      {top.map((p) => (
        <div key={p.id} className="flex items-baseline justify-between gap-4">
          <span className="truncate">{p.name}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {formatCurrency(p.cost ?? 0, 0)}
          </span>
        </div>
      ))}
      {remaining > 0 && <div>+{remaining} more</div>}
    </div>
  );
}
