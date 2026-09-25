import type { ExpenseOut, TaskOut, Trade } from "@cubby/schemas/project";

import { Section, Stack } from "~/components/layout";

import { CategoryBreakdown } from "./charts/category-breakdown";
import { PlannedVsActual } from "./charts/planned-vs-actual";
import { SpendingOverTime } from "./charts/spending-over-time";
import { TaskHeatmap } from "./charts/task-heatmap";
import type { TradeCostCell } from "./charts/trade-cost-matrix";
import type { PivotCostKey } from "./charts/trade-cost-pivot";

export type ProjectDetailAnalyticsViewProps = {
  costEstimate: number | null;
  hasSubtree: boolean;
  expenses: ExpenseOut[];
  topLevelTasks: TaskOut[];
  activeMatrixCell: TradeCostCell | null;
  onMatrixCellClick: (trade: Trade, costType: PivotCostKey | null) => void;
};

/** One optional detail-page analytics interaction and therefore one lazy boundary. */
export function ProjectDetailAnalyticsView({
  costEstimate,
  hasSubtree,
  expenses,
  topLevelTasks,
  activeMatrixCell,
  onMatrixCellClick,
}: ProjectDetailAnalyticsViewProps) {
  return (
    <Stack className="pt-4">
      {expenses.length > 0 && (
        <>
          <Section
            title="Spending Over Time"
            description={
              hasSubtree
                ? "Cumulative spend against the estimate · includes sub-project expenses"
                : "Cumulative spend against the estimate"
            }
          >
            <SpendingOverTime expenses={expenses} costEstimate={costEstimate} />
          </Section>

          <CategoryBreakdown
            expenses={expenses}
            donutHeight={350}
            onMatrixCellClick={onMatrixCellClick}
            activeMatrixCell={activeMatrixCell}
          />

          {expenses.some((expense) => expense.future) && (
            <Section
              title="Planned vs Actual"
              description="Committed spend vs future-flagged expenses"
            >
              <PlannedVsActual expenses={expenses} />
            </Section>
          )}
        </>
      )}

      {topLevelTasks.length > 0 && (
        <Section title="Task Timeline">
          <TaskHeatmap tasks={topLevelTasks} />
        </Section>
      )}
    </Stack>
  );
}
