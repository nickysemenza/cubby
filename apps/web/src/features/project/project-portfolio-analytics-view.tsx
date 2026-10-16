import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";

import { Section, Stack } from "~/ui/layout";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

import { CostVsEstimate } from "./charts/cost-vs-estimate";
import { OpenTasksByProject } from "./charts/open-tasks-by-project";
import { PlannedVsActualByMonth } from "./charts/planned-vs-actual-by-month";
import { TradeActivity } from "./charts/trade-activity";

export type ProjectPortfolioAnalyticsViewProps = {
  data: ProjectPortfolioAnalyticsOut | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
};

/**
 * The portfolio analytics interaction owns one optional chart module. Keeping
 * its chart imports together makes the route pay one lazy request when
 * Analytics is selected, while the normal project dashboard stays light.
 */
export function ProjectPortfolioAnalyticsView({
  data,
  isLoading,
  error,
  onRetry,
}: ProjectPortfolioAnalyticsViewProps) {
  return (
    <Visualization
      state={visualizationState({
        data,
        isLoading,
        error,
        empty: false,
        onRetry,
      })}
      height={400}
    >
      {data && (
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
            <TradeActivity data={data.tradeActivity} />
          </Section>

          <Section
            title="Open Tasks by Project"
            description="Where open work is concentrated"
          >
            <OpenTasksByProject data={data.taskHeatmap} />
          </Section>
        </Stack>
      )}
    </Visualization>
  );
}
