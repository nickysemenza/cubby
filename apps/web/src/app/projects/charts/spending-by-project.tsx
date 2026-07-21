import type { ProjectOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { useNavigate } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { nivoBarChrome, nivoChartTheme, nivoCurrencyAxis } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

/**
 * Spend comes off `project.rollup.spent` — see BudgetHealth. A project with
 * sub-projects uses its `subtree.spent` instead (own + every descendant), so a
 * parent's bar reads as the whole envelope, not just what was logged directly
 * against it.
 */
export function SpendingByProject({ projects }: { projects: ProjectOut[] }) {
  const navigate = useNavigate();

  const data = useMemo(
    () =>
      projects
        // Top-level only: a parent's bar already includes descendant spend via
        // subtree.spent, so letting sub-projects render their own bars would
        // double-count them (same filter as ProjectCards).
        .filter((p) => !p.parentProjectId)
        .map((p) => ({
          project: p.name,
          id: p.id,
          cost:
            p.rollup.subtree.projectCount > 0
              ? p.rollup.subtree.spent
              : p.rollup.spent,
        }))
        .filter((d) => d.cost > 0)
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10)
        .reverse(),
    [projects],
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
