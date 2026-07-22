import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { monthKey, monthLabel } from "~/app/projects/project-formatting";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

type MonthDatum = {
  month: string;
  label: string;
  total: number;
};

/**
 * Net spend bucketed by calendar month — the "cadence" lens over the filtered
 * set. Recurring installments (a hotel payment N/11, a recurring subscription)
 * and seasonal rhythm show up as a repeating pattern across the x-axis in a
 * way a flat total or a cumulative curve can't surface.
 *
 * Purchases are real-world negative sometimes (refunds, a large family
 * contribution) — a month's *net* can legitimately be negative, so it is
 * never filtered out; it renders as a bar below the zero line, colored
 * distinctly from positive spend.
 */
export function MonthlySpend({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => {
    const totals = new Map<string, number>();
    for (const purchase of purchases) {
      if (!purchase.date) continue;
      const key = monthKey(purchase.date);
      totals.set(key, (totals.get(key) ?? 0) + (purchase.cost ?? 0));
    }
    return Array.from(
      totals,
      ([month, total]): MonthDatum => ({
        month,
        label: monthLabel(month),
        total,
      }),
    ).sort((a, b) => a.month.localeCompare(b.month));
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarDays} title="No dated purchase data." />;
  }

  return (
    <div className="h-[300px]">
      <ResponsiveBar
        data={data}
        keys={["total"]}
        indexBy="label"
        margin={{ top: 10, right: 20, bottom: 50, left: 70 }}
        padding={0.3}
        colors={({ data: d }) =>
          d.total < 0 ? "var(--chart-negative)" : "var(--chart-1)"
        }
        {...nivoBarChrome}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          tickRotation: -45,
        }}
        axisLeft={nivoCurrencyAxis}
        label={(d) => formatCurrency(d.value ?? 0, 0)}
        labelSkipHeight={16}
        labelTextColor="var(--background)"
        enableGridX={false}
        enableGridY
        tooltip={({ data: d }) => (
          <ChartTooltip>
            <strong>{d.label}</strong> —{" "}
            <span
              style={{
                color: d.total < 0 ? "var(--chart-negative)" : "var(--chart-1)",
              }}
            >
              {formatCurrency(d.total, 0)}
            </span>
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
