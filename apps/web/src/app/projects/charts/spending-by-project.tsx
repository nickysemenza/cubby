import type { ProjectOut, PurchaseOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import { nivoBarChrome, nivoChartTheme } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

export function SpendingByProject({
  purchases,
  projects,
}: {
  purchases: PurchaseOut[];
  projects: ProjectOut[];
}) {
  const navigate = useNavigate();

  const { data, projectIdMap } = useMemo(() => {
    const nameToId = new Map(projects.map((p) => [p.name, p.id]));
    const byProject = sumByKey(
      purchases,
      (p) => p.projectName ?? "Unassigned",
      (p) => p.cost,
    );

    const data = Array.from(byProject.entries())
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reverse()
      .map(([project, cost]) => ({ project, cost }));

    return { data, projectIdMap: nameToId };
  }, [purchases, projects]);

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
        axisBottom={{
          format: (v: number) => formatCurrency(v, 0),
        }}
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
          const id = projectIdMap.get(bar.indexValue as string);
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
