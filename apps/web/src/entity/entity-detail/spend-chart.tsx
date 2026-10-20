import type { Entity } from "@cubby/schemas/entity";

import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";

import { useMonthlyExpenseSpend } from "./use-detail-data";

const monthLabel = (month: string) =>
  formatCalendarDay(`${month}-01`, "dateShort").replace(/ \d+,/, "");

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
  const peak = Math.max(0, ...months.map((month) => month.cents));
  const trough = Math.max(0, ...months.map((month) => -month.cents));
  const range = Math.max(1, peak + trough);
  // Share of the plot above the zero baseline; all of it without credits.
  const zero = trough === 0 ? 100 : (peak / range) * 100;
  // A tiny month stays visible, but never past its side of the baseline.
  const extent = (cents: number) =>
    `${Math.max(Math.min(6, cents > 0 ? zero : 100 - zero), (Math.abs(cents) / range) * 100)}%`;
  const first = months.at(0);
  const last = months.at(-1);
  return (
    <figure className="min-w-0" data-testid="monthly-spend-chart">
      <figcaption className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-muted-foreground">
          Spend, last 12 months
        </span>
        <span className="font-mono text-xs text-foreground-strong tabular-nums">
          {spend.isPending ? "…" : formatCurrency(total / 100)}
        </span>
      </figcaption>
      <div aria-hidden className="relative mt-1.5 flex h-9 gap-[3px]">
        <div
          className="pointer-events-none absolute inset-x-0 border-b border-border"
          style={{ top: `${zero}%` }}
        />
        {(spend.isPending
          ? Array.from({ length: 12 }, () => null)
          : months
        ).map((month, index) => (
          <div
            // Pending placeholders carry no month; the index is their identity.
            key={month?.month ?? index}
            title={
              month
                ? `${monthLabel(month.month)} · ${formatCurrency(month.cents / 100)}`
                : undefined
            }
            className="relative h-full min-w-0 flex-1"
          >
            {month && month.cents > 0 ? (
              <div
                className="absolute inset-x-0 rounded-t-[2px] bg-foreground-strong/75 hover:bg-foreground-strong"
                style={{
                  bottom: `${100 - zero}%`,
                  height: extent(month.cents),
                }}
              />
            ) : null}
            {month && month.cents < 0 ? (
              <div
                className="absolute inset-x-0 rounded-b-[2px] bg-muted-foreground/45 hover:bg-muted-foreground/70"
                style={{ top: `${zero}%`, height: extent(month.cents) }}
              />
            ) : null}
          </div>
        ))}
      </div>
      {first && last ? (
        <div
          aria-hidden
          className="mt-1 flex justify-between font-mono text-2xs text-muted-foreground"
        >
          <span>{monthLabel(first.month)}</span>
          <span>{monthLabel(last.month)}</span>
        </div>
      ) : null}
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
