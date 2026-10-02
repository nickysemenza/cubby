import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { ProjectExpenseAnalytics } from "~/app/expenses/expense-analytics-view";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { expense } from "~/integrations/tanstack-query/generated/catalog.gen";
import { splitExpenseSpend } from "~/lib/spend";
import { Description } from "~/ui/primitives/description";

import { BudgetStrip } from "./BudgetStrip";
import { ProjectContributionSection } from "./project-contribution-section";
import { projectSubtreeExpensesFilters } from "./project-query-params";
import { ProjectScheduleDetail } from "./project-schedule";

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

/** Expense analytics scoped to this project plus its sub-project subtree. */
export const ProjectAnalytics: DetailSlotComponent<"project"> = ({
  record: project,
}) => <ProjectExpenseAnalytics projectId={project.id} />;
