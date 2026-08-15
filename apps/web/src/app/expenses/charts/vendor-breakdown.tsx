import type { ExpenseVendorAggregate } from "@cubby/schemas/project";
import { Store } from "lucide-react";
import { useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { HorizontalBarChart } from "~/app/projects/charts/horizontal-bar-chart";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

/**
 * Net spend by vendor — sourced from `expense.analytics`'s `byVendor`
 * aggregate. The twin of `ProjectBreakdown`, down to the top-12-by-absolute-net
 * cut, so a roster of ~114 vendors doesn't produce an unreadably tall bar list.
 *
 * Expenses with no Purchase attached (no Vendor recorded) are excluded
 * server-side by the inner join, so these bars deliberately do NOT sum to the
 * Net stat tile above — see `repo/expense/analytics.ts`.
 */
export function VendorBreakdown({
  byVendor,
}: {
  byVendor: ExpenseVendorAggregate[];
}) {
  const data = useMemo(
    () =>
      [...byVendor]
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        .slice(0, 12)
        .map((row) => ({ vendor: row.vendorName, net: row.net }))
        .reverse(),
    [byVendor],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={Store} title="No vendor-linked expenses." />;
  }

  return (
    <HorizontalBarChart
      data={data}
      minHeight={240}
      keys={["net"]}
      indexBy="vendor"
      margin={{ top: 10, right: 40, bottom: 40, left: 160 }}
      padding={0.25}
      colors={({ data: d }) =>
        d.net < 0 ? "var(--chart-negative)" : "var(--chart-1)"
      }
      {...nivoBarChrome}
      axisBottom={nivoCurrencyAxis}
      axisLeft={{ tickSize: 0, tickPadding: 8 }}
      enableLabel={false}
      enableGridX
      enableGridY={false}
      tooltip={({ data: d }) => (
        <ChartTooltip>
          <strong>{d.vendor}</strong> —{" "}
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
  );
}
