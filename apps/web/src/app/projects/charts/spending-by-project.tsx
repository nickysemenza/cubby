import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { nivoBarChrome, nivoChartTheme, nivoCurrencyAxis } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

/**
 * `data` is `portfolioAnalytics`'s `spendingByProject` — subtree `spent`
 * (net actual + committed + credits) per project matching the dashboard's
 * current filter scope, already sorted server-side (see repo/project/
 * portfolio-analytics.ts).
 */
export function SpendingByProject({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["spendingByProject"];
}) {
  const navigate = useNavigate();

  const data = useMemo(
    () =>
      rows
        .filter((r) => r.spend > 0)
        .slice(0, 10)
        .map((r) => ({
          project: r.projectName,
          id: r.projectId,
          cost: r.spend,
        }))
        .reverse(),
    [rows],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={Wallet} title="No spending data." />;
  }

  const chartHeight = Math.max(250, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["cost"]}
        indexBy="project"
        layout="horizontal"
        margin={{ top: 10, right: 80, bottom: 30, left: 160 }}
        padding={0.3}
        colors={["var(--chart-1)"]}
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={50}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        onClick={(bar) => {
          const id = bar.data.id;
          if (id) navigate({ to: "/projects/$id", params: { id } });
        }}
        tooltip={({ indexValue, value }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong>: {formatCurrency(value, 0)}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
