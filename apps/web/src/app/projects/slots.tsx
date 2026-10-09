import { ProjectExpenseAnalytics } from "~/app/expenses/expense-analytics-view";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";

import { ProjectScheduleDetail } from "./project-schedule";

/** Estimate against actual, committed and contributed spend over the subtree. */
export const ProjectBudget: DetailSlotComponent<"project"> = ({
  record: project,
}) => <EntityReportSlot slot="project.budget" id={project.id} />;

/** Whole-group cost, who consumed and initially funded it, and the attribution gaps. */
export const ProjectContribution: DetailSlotComponent<"project"> = ({
  record: project,
}) => <EntityReportSlot slot="project.contribution" id={project.id} />;

export const ProjectSchedule: DetailSlotComponent<"project"> = ({
  record: project,
}) => <ProjectScheduleDetail projectId={project.id} name={project.name} />;

/** Expense analytics scoped to this project plus its sub-project subtree. */
export const ProjectAnalytics: DetailSlotComponent<"project"> = ({
  record: project,
}) => <ProjectExpenseAnalytics projectId={project.id} />;
