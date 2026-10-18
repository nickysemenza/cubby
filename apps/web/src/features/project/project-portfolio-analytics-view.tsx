import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";

import { IndexedSections } from "~/ui/data-table/indexed-sections";
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
        <IndexedSections
          groups={[
            {
              id: "detail-group-analytics",
              title: "Portfolio analytics",
              sections: [
                {
                  id: "cost-vs-estimate",
                  icon: ChartBarIcon,
                  overflowVisible: true,
                  title: "Cost vs Estimate",
                  description:
                    "% of budget spent — projects with an estimate only",
                  content: <CostVsEstimate data={data.costVsEstimate} />,
                },
                {
                  id: "planned-vs-actual",
                  icon: ChartBarIcon,
                  overflowVisible: true,
                  title: "Planned vs Actual",
                  description:
                    "Committed spend vs future-flagged expenses, by month",
                  content: (
                    <PlannedVsActualByMonth data={data.plannedVsActual} />
                  ),
                },
                {
                  id: "spend-by-trade",
                  icon: ChartBarIcon,
                  overflowVisible: true,
                  title: "Spend by Trade",
                  description: "Actual + committed spend per trade",
                  content: <TradeActivity data={data.tradeActivity} />,
                },
                {
                  id: "open-tasks",
                  icon: ChartBarIcon,
                  overflowVisible: true,
                  title: "Open Tasks by Project",
                  description: "Where open work is concentrated",
                  content: <OpenTasksByProject data={data.taskHeatmap} />,
                },
              ],
            },
          ]}
        />
      )}
    </Visualization>
  );
}
