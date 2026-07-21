import type { ProjectOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { DollarSign } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { nivoBarChrome, nivoChartTheme, nivoCurrencyAxis } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type Datum = {
  project: string;
  actual: number;
  estimate: number;
};

/**
 * Actual spend comes off `project.rollup.spent` (a SQL aggregate over live
 * purchases, including `future` ones). A project with sub-projects uses its
 * `subtree.spent` instead (own + every
 * descendant), so a parent's bar reads as the whole envelope, not just what
 * was logged directly against it.
 */
export function CostVsEstimate({ projects }: { projects: ProjectOut[] }) {
  const data = useMemo(() => {
    return (
      projects
        // Top-level only: a parent's bar already includes descendant spend via
        // subtree.spent, so letting sub-projects render their own bars would
        // double-count them (same filter as ProjectCards).
        .filter((p) => !p.parentProjectId)
        .map((p) => ({
          project: p.name,
          actual:
            p.rollup.subtree.projectCount > 0
              ? p.rollup.subtree.spent
              : p.rollup.spent,
          estimate: p.costEstimate ?? 0,
        }))
        .filter((d) => d.actual > 0 && d.estimate > 0)
        .sort(
          (a, b) =>
            Math.max(b.actual, b.estimate) - Math.max(a.actual, a.estimate),
        )
        .slice(0, 12) as Datum[]
    );
  }, [projects]);

  if (data.length === 0) {
    return <ChartEmpty icon={DollarSign} title="No cost data." />;
  }

  const chartHeight = Math.max(250, data.length * 50 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["actual", "estimate"]}
        indexBy="project"
        layout="horizontal"
        groupMode="grouped"
        margin={{ top: 10, right: 80, bottom: 40, left: 160 }}
        padding={0.2}
        innerPadding={2}
        colors={({ id, data: d }) => {
          if (id === "estimate") return "var(--chart-neutral)";
          return d.actual > d.estimate && d.estimate > 0
            ? "var(--chart-negative)"
            : "var(--chart-1)";
        }}
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
        tooltip={({ id, value, indexValue }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong> — {id}: {formatCurrency(value, 0)}
          </ChartTooltip>
        )}
        legends={[
          {
            dataFrom: "keys",
            anchor: "bottom",
            direction: "row",
            translateY: 40,
            itemWidth: 80,
            itemHeight: 20,
            symbolSize: 12,
            symbolShape: "circle",
          },
        ]}
        theme={nivoChartTheme}
      />
    </div>
  );
}
