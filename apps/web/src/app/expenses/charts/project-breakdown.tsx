import type { ExpenseProjectAggregate } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { Building2 } from "lucide-react";
import { useMemo } from "react";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import {
  ProjectChartLabel,
  ProjectChartTick,
} from "~/app/projects/project-mark";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

/**
 * Net spend by project — sourced from `expense.analytics`'s `byProject`
 * aggregate. Top 12 by absolute net so a household with many small/finished
 * projects doesn't produce an unreadably tall bar list; inbox expenses
 * (`projectId: null`) are already excluded server-side (see
 * `repo/expense/analytics.ts`'s inner join).
 */
export function ProjectBreakdown({
  byProject,
}: {
  byProject: ExpenseProjectAggregate[];
}) {
  const { iconById } = useProjectOptions();
  const data = useMemo(
    () =>
      [...byProject]
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        .slice(0, 12)
        .map((row) => ({
          id: row.projectId,
          name: row.projectName,
          net: row.net,
        }))
        .reverse(),
    [byProject],
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
    return <ChartEmpty icon={Building2} title="No project-linked expenses." />;
  }

  const chartHeight = Math.max(240, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["net"]}
        indexBy="id"
        layout="horizontal"
        margin={{ top: 10, right: 40, bottom: 40, left: 180 }}
        padding={0.25}
        colors={({ data: d }) =>
          Number(d.net) < 0 ? "var(--chart-negative)" : "var(--chart-1)"
        }
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          renderTick: (tick) => (
            <ProjectChartTick {...tick} identityById={identityById} />
          ),
        }}
        enableLabel={false}
        enableGridX
        enableGridY={false}
        tooltip={({ data: d }) => (
          <ChartTooltip>
            <strong>
              <ProjectChartLabel
                identity={
                  identityById.get(String(d.id)) ?? {
                    name: String(d.name),
                    icon: null,
                  }
                }
              />
            </strong>{" "}
            —{" "}
            <span
              style={{
                color:
                  Number(d.net) < 0
                    ? "var(--chart-negative)"
                    : "var(--chart-1)",
              }}
            >
              {formatCurrency(Number(d.net), 0)}
            </span>
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
