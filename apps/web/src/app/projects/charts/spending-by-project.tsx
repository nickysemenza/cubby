import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import type { NotionProject, NotionPurchase } from "~/server/clients/notion";
import { nivoChartTheme } from "../shared";
import { ChartEmpty } from "./chart-empty";

export function SpendingByProject({
  purchases,
  projects,
}: {
  purchases: NotionPurchase[];
  projects: NotionProject[];
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
        colors={["hsl(210, 60%, 55%)"]}
        borderRadius={2}
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
        labelTextColor="white"
        enableGridX
        enableGridY={false}
        onClick={(bar) => {
          const id = projectIdMap.get(bar.indexValue as string);
          if (id) navigate({ to: "/projects/$id", params: { id } });
        }}
        tooltip={({ indexValue, value }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            <strong>{indexValue}</strong>: {formatCurrency(value, 0)}
          </div>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
