import type { ExpenseOut, TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { expense } from "~/app/expenses/expense.functions";
import { task } from "~/app/tasks/task.functions";
import { Description } from "~/components/ui/description";
import { splitExpenseSpend } from "~/lib/spend";

import { BudgetStrip } from "./BudgetStrip";
import type { TradeCostCell } from "./charts/trade-cost-matrix";
import type { PivotCostKey } from "./charts/trade-cost-pivot";
import { ProjectContributionSection } from "./project-contribution-section";
import { ProjectDetailAnalyticsView } from "./project-detail-analytics-view";
import {
  projectSubtreeExpensesFilters,
  projectSubtreeTasksFilters,
} from "./project-query-params";
import { ProjectScheduleDetail } from "./project-schedule";

const NO_TASKS: TaskOut[] = [];
const NO_EXPENSES: ExpenseOut[] = [];

/** Estimate against actual, committed and contributed spend over the subtree. */
export const ProjectBudget: DetailSlotComponent<"project"> = ({
  record: project,
}) => {
  const { data: chartExpenses = NO_EXPENSES } = useQuery(
    expense.chartData.queryOptions(projectSubtreeExpensesFilters(project.id)),
  );
  const split = useMemo(
    () => splitExpenseSpend(chartExpenses),
    [chartExpenses],
  );
  const estimate = project.rollup.subtree.costEstimate ?? project.costEstimate;
  if (estimate == null && chartExpenses.length === 0)
    return (
      <Description size="xs">
        No estimate or spend yet — set a cost estimate or log the first expense.
      </Description>
    );
  return <BudgetStrip estimate={estimate} split={split} />;
};

export const ProjectContribution: DetailSlotComponent<"project"> = ({
  record: project,
}) => <ProjectContributionSection projectId={project.id} />;

export const ProjectSchedule: DetailSlotComponent<"project"> = ({
  record: project,
}) => <ProjectScheduleDetail projectId={project.id} record={project} />;

/**
 * Spending/task charts scoped to this project PLUS its whole sub-project
 * subtree. Expense-dependent charts and the task timeline gate
 * independently — a project with tasks but no expenses (or vice versa) still
 * sees its own section.
 */
export const ProjectAnalytics: DetailSlotComponent<"project"> = ({
  record: project,
}) => {
  const { data: subtreeTasks = NO_TASKS } = useQuery(
    task.chartData.queryOptions(projectSubtreeTasksFilters(project.id)),
  );
  const topLevelTasks = useMemo(
    () => subtreeTasks.filter((candidate) => candidate.parentTaskId == null),
    [subtreeTasks],
  );
  const { data: chartExpenses = NO_EXPENSES } = useQuery(
    expense.chartData.queryOptions(projectSubtreeExpensesFilters(project.id)),
  );
  const [activeMatrixCell, setActiveMatrixCell] =
    useState<TradeCostCell | null>(null);
  const toggleMatrixCell = (
    trade: TradeCostCell["trade"],
    costType: PivotCostKey | null,
  ) =>
    setActiveMatrixCell((current) =>
      current?.trade === trade && current.costType === costType
        ? null
        : { trade, costType },
    );
  if (chartExpenses.length === 0 && subtreeTasks.length === 0)
    return (
      <Description size="xs">
        Nothing to chart yet — expenses and tasks feed these views.
      </Description>
    );
  return (
    <ProjectDetailAnalyticsView
      costEstimate={project.rollup.subtree.costEstimate}
      hasSubtree={project.rollup.subtree.projectCount > 0}
      expenses={chartExpenses}
      topLevelTasks={topLevelTasks}
      activeMatrixCell={activeMatrixCell}
      onMatrixCellClick={toggleMatrixCell}
    />
  );
};
