import { Gauge } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import type { NotionProject, NotionPurchase } from "~/server/clients/notion";
import { ChartEmpty } from "./chart-empty";

type ProjectBudget = {
  name: string;
  actual: number;
  estimate: number;
  pct: number; // percentage of estimate spent
};

export function BudgetHealth({
  projects,
  purchases,
}: {
  projects: NotionProject[];
  purchases: NotionPurchase[];
}) {
  const data = useMemo(() => {
    const costByProject = sumByKey(
      purchases.filter((p) => p.projectName && p.cost),
      (p) => p.projectName,
      (p) => p.cost,
    );

    return projects
      .filter((p) => p.costEstimate && p.costEstimate > 0)
      .map((p) => ({
        name: p.name,
        actual: costByProject.get(p.name) ?? 0,
        estimate: p.costEstimate!,
        pct: ((costByProject.get(p.name) ?? 0) / p.costEstimate!) * 100,
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 12) as ProjectBudget[];
  }, [projects, purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={Gauge} title="No projects with estimates." />;
  }

  const maxPct = Math.max(...data.map((d) => d.pct), 100);

  return (
    <div className="space-y-4">
      {data.map((d) => {
        const overBudget = d.pct > 100;
        const barWidth = Math.min((d.pct / maxPct) * 100, 100);
        const diff = d.actual - d.estimate;

        return (
          <div key={d.name} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">{d.name}</span>
              <span
                className={`shrink-0 text-xs ${overBudget ? "text-destructive" : "text-muted-foreground"}`}
              >
                {d.pct.toFixed(0)}%
                {overBudget
                  ? ` (+${formatCurrency(diff, 0)})`
                  : ` (${formatCurrency(d.estimate - d.actual, 0)} left)`}
              </span>
            </div>
            <div className="relative h-3 w-full overflow-hidden bg-muted">
              <div
                className={`h-full transition-all ${overBudget ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${barWidth}%` }}
              />
              {/* 100% marker */}
              <div
                className="absolute top-0 h-full w-px bg-foreground/30"
                style={{ left: `${(100 / maxPct) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
