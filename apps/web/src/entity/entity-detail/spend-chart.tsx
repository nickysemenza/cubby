import type { Entity } from "@cubby/schemas/entity";

import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";

import { useMonthlyExpenseSpend } from "./use-detail-data";

const monthLabel = (month: string) =>
  formatCalendarDay(`${month}-01`, "monthShort");
const monthReadoutLabel = (month: string) =>
  formatCalendarDay(`${month}-01`, "monthYearLong");

/**
 * Twelve months of `SUM(Expense.cost)` reached through the entity's declared
 * relation, as bars closing the key-numbers strip. Credits net into their
 * month; a month that nets below zero draws below the zero baseline.
 */
export function MonthlySpendChart({
  entity,
  id,
}: {
  entity: Entity;
  id: string;
}) {
  const spend = useMonthlyExpenseSpend({
    source: { entityKind: entity, entityId: id },
  });
  if (spend.isError)
    return <ErrorDisplay error={spend.error} title="monthly spend" />;
  const months = spend.data ?? [];
  const total = months.reduce((sum, month) => sum + month.cents, 0);
  const average = months.length > 0 ? total / months.length : undefined;
  const peak = Math.max(0, ...months.map((month) => month.cents));
  const trough = Math.max(0, ...months.map((month) => -month.cents));
  const range = Math.max(1, peak + trough);
  // Leave room for month labels and the average caption below the baseline.
  const chartTop = 8;
  const chartBottom = trough === 0 ? 75 : 82;
  const plotRange = chartBottom - chartTop;
  const zero =
    peak === 0 && trough === 0
      ? chartBottom
      : chartTop + (peak / range) * plotRange;
  // A tiny month stays visible as a pixel, without crossing the baseline.
  const extent = (cents: number) =>
    `${Math.max(100 / 120, (Math.abs(cents) / range) * plotRange)}%`;
  const averagePosition =
    average === undefined
      ? undefined
      : peak === 0 && trough === 0
        ? zero
        : chartTop + ((peak - average) / range) * plotRange;
  const last = months.at(-1);
  return (
    <figure
      className="min-w-0"
      data-testid="monthly-spend-chart"
      aria-busy={spend.isPending || undefined}
    >
      <figcaption className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-muted-foreground">
          Spend, last 12 months
        </span>
        <span className="font-mono text-xs text-foreground-strong tabular-nums">
          {spend.isPending ? "…" : formatCurrency(total / 100)}
        </span>
      </figcaption>
      <div className="relative mt-1.5 flex h-30 gap-[3px]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-0 border-b border-muted-foreground/35"
          style={{ top: `${zero}%` }}
        />
        {average !== undefined && averagePosition !== undefined ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-muted-foreground/60"
              style={{ top: `${averagePosition}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute right-0 z-20 -translate-y-1/2 bg-background/90 px-1 font-mono text-xs text-muted-foreground tabular-nums"
              style={{ top: `${averagePosition}%` }}
            >
              avg {formatCurrency(average / 100)}
            </span>
          </>
        ) : null}
        {(spend.isPending
          ? Array.from({ length: 12 }, () => null)
          : months
        ).map((month, index) => (
          <div
            // Pending placeholders carry no month; the index is their identity.
            key={month?.month ?? index}
            role={month ? "img" : undefined}
            tabIndex={month ? 0 : undefined}
            aria-label={
              month
                ? `${monthReadoutLabel(month.month)} spend: ${formatCurrency(month.cents / 100)}`
                : undefined
            }
            className="group relative h-full min-w-0 flex-1 rounded-sm outline-none focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {month && month.cents !== 0 ? (
              <div
                aria-hidden
                className={`absolute left-1/2 w-3/5 -translate-x-1/2 ${month.month === last?.month ? "bg-foreground-strong" : "bg-muted-foreground/25"}`}
                style={{
                  bottom: month.cents > 0 ? `${100 - zero}%` : undefined,
                  top: month.cents < 0 ? `${zero}%` : undefined,
                  height: extent(month.cents),
                }}
              />
            ) : null}
            {month ? (
              <span className="pointer-events-none absolute top-1 left-1/2 z-20 hidden -translate-x-1/2 rounded-sm bg-foreground-strong px-2 py-1 text-xs whitespace-nowrap text-background tabular-nums group-hover:block group-focus-visible:block">
                {monthReadoutLabel(month.month)} ·{" "}
                {formatCurrency(month.cents / 100)}
              </span>
            ) : null}
            {month ? (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 text-center font-sans text-xs text-muted-foreground">
                {monthLabel(month.month).slice(0, 1)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <dl className="sr-only">
        {months.map((month) => (
          <div key={month.month}>
            <dt>{monthLabel(month.month)}</dt>
            <dd>{formatCurrency(month.cents / 100)}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}
