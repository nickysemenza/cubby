import type { ExpenseMonthlyAggregate } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { CalendarDotsIcon as CalendarDays } from "@phosphor-icons/react/dist/csr/CalendarDots";
import { useMemo } from "react";

import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { monthLabel } from "~/app/projects/project-formatting";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

type MonthDatum = {
  month: string;
  label: string;
  net: number;
};

/**
 * Net spend bucketed by calendar month — the "cadence" lens over the filtered
 * set, sourced from `expense.analytics`'s server-side `monthly` aggregate
 * (grouped SQL sums), not a client-side reduction over a raw expense fetch.
 * Recurring installments (a hotel payment N/11, a recurring subscription) and
 * seasonal rhythm show up as a repeating pattern across the x-axis in a way a
 * flat total or a cumulative curve can't surface.
 *
 * Expenses are real-world negative sometimes (refunds, a large family
 * contribution) — a month's *net* can legitimately be negative, so it is
 * never filtered out; it renders as a bar below the zero line, colored
 * distinctly from positive spend.
 */
export function MonthlySpend({
  monthly,
  compact = false,
}: {
  monthly: ExpenseMonthlyAggregate[];
  /** Home dashboards need the same honest aggregate in a shorter, quieter frame. */
  compact?: boolean;
}) {
  const data = useMemo(
    (): MonthDatum[] =>
      monthly.map((row) => ({
        month: row.month,
        label: monthLabel(row.month),
        net: row.net,
      })),
    [monthly],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarDays} title="No dated expense data." />;
  }

  // Thin the month axis to ~12 labels — every bar labeled overlaps once the
  // range spans years.
  const stride = Math.ceil(data.length / 12);
  const monthTicks = data
    .map((d) => d.label)
    .filter((_, i) => i % stride === 0);

  // On the home dashboard this chart sits beside four other panels, so every
  // bar in the accent made the accent mean nothing (DESIGN.md's One Loud Thing
  // rule). Compact mode paints the ink ladder and spends the ultramarine on the
  // single current month — which is also the figure the card headlines, and
  // which one outlier month's y-axis otherwise renders as an unfindable sliver.
  // The full-page chart is its own page's subject and keeps the accent.
  const currentMonth = data.at(-1)?.month;
  const barColor = ({ data: d }: { data: MonthDatum }) => {
    if (d.net < 0) return "var(--chart-negative)";
    if (!compact) return "var(--chart-1)";
    return d.month === currentMonth ? "var(--chart-1)" : "var(--chart-2)";
  };

  return (
    <div className={compact ? "h-40" : "h-[300px]"}>
      <ResponsiveBar
        data={data}
        keys={["net"]}
        indexBy="label"
        margin={
          compact
            ? { top: 8, right: 8, bottom: 28, left: 46 }
            : { top: 10, right: 20, bottom: 50, left: 70 }
        }
        padding={0.3}
        colors={barColor}
        {...nivoBarChrome}
        axisBottom={{
          tickSize: 0,
          tickPadding: compact ? 5 : 8,
          tickRotation: compact ? 0 : -45,
          tickValues: monthTicks,
        }}
        axisLeft={nivoCurrencyAxis}
        // Per-bar value labels collide on narrow bars; the tooltip carries the
        // exact figure on hover instead.
        enableLabel={false}
        enableGridX={false}
        enableGridY
        tooltip={({ data: d }) => (
          <ChartTooltip>
            <strong>{d.label}</strong> —{" "}
            <span
              style={{
                color: d.net < 0 ? "var(--chart-negative)" : "var(--chart-1)",
              }}
            >
              {formatCurrency(d.net, 0)}
            </span>
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
