import type { PurchaseProjectAggregate } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { Building2 } from "lucide-react";
import { useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

/**
 * Net spend by project — sourced from `purchase.analytics`'s `byProject`
 * aggregate. Top 12 by absolute net so a household with many small/finished
 * projects doesn't produce an unreadably tall bar list; inbox purchases
 * (`projectId: null`) are already excluded server-side (see
 * `repo/purchase/analytics.ts`'s inner join).
 */
export function ProjectBreakdown({
  byProject,
}: {
  byProject: PurchaseProjectAggregate[];
}) {
  const data = useMemo(
    () =>
      [...byProject]
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        .slice(0, 12)
        .map((row) => ({ project: row.projectName, net: row.net }))
        .reverse(),
    [byProject],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={Building2} title="No project-linked purchases." />;
  }

  const chartHeight = Math.max(240, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["net"]}
        indexBy="project"
        layout="horizontal"
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
            <strong>{d.project}</strong> —{" "}
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
