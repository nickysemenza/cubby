import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { entityDetailLink } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";
import { ProjectChartLabel, ProjectChartTick } from "../project-mark";
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
  const { iconById } = useProjectOptions();

  const data = useMemo(
    () =>
      rows
        .filter((r) => r.spend > 0)
        .slice(0, 10)
        .map((r) => ({
          id: r.projectId,
          name: r.projectName,
          cost: r.spend,
        }))
        .reverse(),
    [rows],
  );
  const identityById = useMemo(
    () =>
      new Map<string, { name: string; icon: string | null }>(
        data.map(
          (row) =>
            [
              String(row.id),
              { name: row.name, icon: iconById.get(row.id) ?? null },
            ] as const,
        ),
      ),
    [data, iconById],
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
        indexBy="id"
        layout="horizontal"
        margin={{ top: 10, right: 80, bottom: 30, left: 180 }}
        padding={0.3}
        colors={["var(--chart-1)"]}
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          renderTick: (tick) => (
            <ProjectChartTick {...tick} identityById={identityById} />
          ),
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={50}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        onClick={(bar) => {
          const shortcode = bar.data.id;
          if (shortcode)
            navigate(entityDetailLink("project", String(shortcode)));
        }}
        tooltip={({ data: row, value }) => (
          <ChartTooltip>
            <strong>
              <ProjectChartLabel
                identity={
                  identityById.get(String(row.id)) ?? {
                    name: String(row.name),
                    icon: null,
                  }
                }
              />
            </strong>
            : {formatCurrency(value, 0)}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
