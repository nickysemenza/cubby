import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";

import { Section, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";

import { CostVsEstimate } from "./charts/cost-vs-estimate";
import { OpenTasksByProject } from "./charts/open-tasks-by-project";
import { PlannedVsActualByMonth } from "./charts/planned-vs-actual-by-month";
import { TradeActivity } from "./charts/trade-activity";

export type ProjectPortfolioAnalyticsViewProps = {
  data: ProjectPortfolioAnalyticsOut | undefined;
  isLoading: boolean;
};

/**
 * The portfolio analytics interaction owns one optional chart module. Keeping
 * its chart imports together makes the route pay one lazy request when
 * Analytics is selected, while the normal project dashboard stays light.
 */
export function ProjectPortfolioAnalyticsView({
  data,
  isLoading,
}: ProjectPortfolioAnalyticsViewProps) {
  if (isLoading || !data) {
    return <Skeleton className="h-[400px] w-full" />;
  }

  return (
    <Stack className="pt-4">
      <Section
        title="Cost vs Estimate"
        description="% of budget spent — projects with an estimate only"
      >
        <CostVsEstimate data={data.costVsEstimate} />
      </Section>

      <Section
        title="Planned vs Actual"
        description="Committed spend vs future-flagged expenses, by month"
      >
        <PlannedVsActualByMonth data={data.plannedVsActual} />
      </Section>

      <Section
        title="Spend by Trade"
        description="Actual + committed spend per trade"
      >
        <TradeActivity
          data={data.tradeActivity}
          adjustments={data.adjustments.net}
        />
      </Section>

      <Section
        title="Open Tasks by Project"
        description="Where open work is concentrated"
      >
        <OpenTasksByProject data={data.taskHeatmap} />
      </Section>
    </Stack>
  );
}
