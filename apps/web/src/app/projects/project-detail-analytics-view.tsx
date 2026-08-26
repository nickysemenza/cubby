import type {
  ExpenseOut,
  ProjectOut,
  TaskOut,
  Trade,
} from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { Section, Stack } from "~/components/layout";
import { entities, entityDetailParams } from "~/entities/entities";
import { parsePlainDate } from "~/lib/plain-date";
import { CategoryBreakdown } from "./charts/category-breakdown";
import { ProjectGantt } from "./charts/gantt/ProjectGantt";
import { PlannedVsActual } from "./charts/planned-vs-actual";
import { SpendingOverTime } from "./charts/spending-over-time";
import { TaskHeatmap } from "./charts/task-heatmap";
import type { TradeCostCell } from "./charts/trade-cost-matrix";
import type { PivotCostKey } from "./charts/trade-cost-pivot";
import {
  formatDate,
  formatDateRange,
  PROJECT_STATUS_LABELS,
  TRADE_LABELS,
} from "./project-formatting";
import { TASK_STATUS_LABELS } from "./shared";

type ProjectAgendaEntry =
  | { kind: "task"; day: string; task: TaskOut }
  | { kind: "project"; day: string; project: ProjectOut };

export type ProjectAgendaGroup = {
  day: string;
  entries: ProjectAgendaEntry[];
};

/**
 * The phone companion to the project Gantt. A task appears at its own start,
 * or at its end when only an end constraint is known, while a sub-project
 * appears at the beginning of its effective date window. This keeps a long
 * renovation readable without pretending the detailed Gantt can shrink into
 * a phone.
 */
export function buildProjectAgendaGroups(
  projectId: string,
  tasks: readonly TaskOut[],
  subtreeProjects: readonly ProjectOut[],
): ProjectAgendaGroup[] {
  const entries: ProjectAgendaEntry[] = [];

  for (const task of tasks) {
    const day = task.dueDate ?? task.dueEndDate;
    if (day) entries.push({ kind: "task", day, task });
  }
  for (const project of subtreeProjects) {
    if (project.id === projectId) continue;
    const day = project.dates.effectiveStart ?? project.dates.effectiveEnd;
    if (day) entries.push({ kind: "project", day, project });
  }

  const grouped = new Map<string, ProjectAgendaEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.day);
    if (group) group.push(entry);
    else grouped.set(entry.day, [entry]);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, group]) => ({
      day,
      entries: [...group].sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "project" ? -1 : 1;
        const leftName =
          left.kind === "project" ? left.project.name : left.task.name;
        const rightName =
          right.kind === "project" ? right.project.name : right.task.name;
        return leftName.localeCompare(rightName);
      }),
    }));
}

export function formatProjectAgendaTaskDate(task: TaskOut): string {
  return task.dueDate
    ? formatDateRange(task.dueDate, task.dueEndDate)
    : `Ends ${formatDate(task.dueEndDate!)}`;
}

function undatedSubprojects(
  projectId: string,
  subtreeProjects: readonly ProjectOut[],
): ProjectOut[] {
  return subtreeProjects.filter(
    (project) =>
      project.id !== projectId &&
      project.dates.effectiveStart == null &&
      project.dates.effectiveEnd == null,
  );
}

function ProjectTimelineAgenda({
  projectId,
  tasks,
  subtreeProjects,
}: {
  projectId: string;
  tasks: TaskOut[];
  subtreeProjects: ProjectOut[];
}) {
  const groups = buildProjectAgendaGroups(projectId, tasks, subtreeProjects);
  const unscheduledTasks = tasks.filter(
    (task) => task.dueDate == null && task.dueEndDate == null,
  );
  const unscheduledProjects = undatedSubprojects(projectId, subtreeProjects);

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        Dated work in order. The interactive Gantt is available on wider
        screens.
      </p>
      {groups.length > 0 ? (
        <section className="border" aria-label="Project timeline agenda">
          {groups.map((group) => (
            <section key={group.day}>
              <h3 className="flex min-h-8 items-center gap-2 border-b bg-muted px-2 font-mono text-2xs uppercase tracking-wider">
                {format(parsePlainDate(group.day), "EEE MMM d")}
                <span className="ml-auto text-slate tabular-nums">
                  {group.entries.length}
                </span>
              </h3>
              <div>
                {group.entries.map((entry) =>
                  entry.kind === "task" ? (
                    <div
                      key={`task-${entry.task.id}`}
                      className="border-b last:border-b-0"
                    >
                      <Link
                        to={entities.task.routes.detail}
                        params={entityDetailParams(entry.task.id)}
                        className="flex min-h-11 min-w-0 items-center justify-between gap-2 px-2 py-1.5 hover:bg-muted"
                      >
                        <span className="min-w-0 truncate font-medium text-sm">
                          {entry.task.name}
                        </span>
                        <span className="shrink-0 font-mono text-2xs text-slate">
                          {formatProjectAgendaTaskDate(entry.task)}
                        </span>
                      </Link>
                      <div className="flex min-h-7 items-center gap-x-2 border-t px-2 py-1 font-mono text-2xs text-slate">
                        <span>Task</span>
                        <span>{TASK_STATUS_LABELS[entry.task.status]}</span>
                        <span>{TRADE_LABELS[entry.task.trade]}</span>
                      </div>
                      {entry.task.projectId && entry.task.projectName && (
                        <Link
                          to={entities.project.routes.detail}
                          params={entityDetailParams(entry.task.projectId)}
                          className="flex min-h-11 items-center border-t px-2 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
                        >
                          In project: {entry.task.projectName}
                        </Link>
                      )}
                    </div>
                  ) : (
                    <div
                      key={`project-${entry.project.id}`}
                      className="border-b last:border-b-0"
                    >
                      <Link
                        to={entities.project.routes.detail}
                        params={entityDetailParams(entry.project.id)}
                        className="flex min-h-11 min-w-0 items-center justify-between gap-2 px-2 py-1.5 hover:bg-muted"
                      >
                        <span className="min-w-0 truncate font-medium text-sm">
                          {entry.project.name}
                        </span>
                        <span className="shrink-0 font-mono text-2xs text-slate">
                          {entry.project.dates.effectiveStart
                            ? formatDateRange(
                                entry.project.dates.effectiveStart,
                                entry.project.dates.effectiveEnd,
                              )
                            : `Ends ${formatDate(entry.project.dates.effectiveEnd!)}`}
                        </span>
                      </Link>
                      <div className="flex min-h-7 items-center gap-2 border-t px-2 py-1 font-mono text-2xs text-slate">
                        <span>Sub-project</span>
                        <span>
                          {PROJECT_STATUS_LABELS[entry.project.status]}
                        </span>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </section>
          ))}
        </section>
      ) : (
        <p className="border-y py-4 text-center text-muted-foreground text-xs">
          No dated tasks or sub-projects yet.
        </p>
      )}

      {(unscheduledTasks.length > 0 || unscheduledProjects.length > 0) && (
        <section className="border" aria-label="Unscheduled project work">
          <h3 className="flex min-h-8 items-center border-b bg-muted px-2 font-mono text-2xs uppercase tracking-wider">
            Not scheduled ·{" "}
            {unscheduledTasks.length + unscheduledProjects.length}
          </h3>
          {unscheduledProjects.map((project) => (
            <Link
              key={project.id}
              to={entities.project.routes.detail}
              params={entityDetailParams(project.id)}
              className="flex min-h-11 items-center border-b px-2 font-medium text-sm hover:bg-muted"
            >
              Sub-project: {project.name}
            </Link>
          ))}
          {unscheduledTasks.map((task) => (
            <Link
              key={task.id}
              to={entities.task.routes.detail}
              params={entityDetailParams(task.id)}
              className="flex min-h-11 items-center border-b px-2 font-medium text-sm last:border-b-0 hover:bg-muted"
            >
              Task: {task.name}
            </Link>
          ))}
        </section>
      )}
    </Stack>
  );
}

export type ProjectDetailAnalyticsViewProps = {
  projectId: ProjectOut["id"];
  costEstimate: number | null;
  hasSubtree: boolean;
  expenses: ExpenseOut[];
  tasks: TaskOut[];
  topLevelTasks: TaskOut[];
  subtreeProjects: ProjectOut[];
  activeMatrixCell: TradeCostCell | null;
  onMatrixCellClick: (trade: Trade, costType: PivotCostKey | null) => void;
};

/** One optional detail-page analytics interaction and therefore one lazy boundary. */
export function ProjectDetailAnalyticsView({
  projectId,
  costEstimate,
  hasSubtree,
  expenses,
  tasks,
  topLevelTasks,
  subtreeProjects,
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

      {(tasks.length > 0 || subtreeProjects.length > 0) && (
        <Section
          title="Timeline"
          description={
            subtreeProjects.length > 0
              ? "Tasks and sub-projects across the whole subtree."
              : "Scheduled tasks across this project."
          }
        >
          <div className="md:hidden">
            <ProjectTimelineAgenda
              projectId={projectId}
              tasks={tasks}
              subtreeProjects={subtreeProjects}
            />
          </div>
          <div className="hidden md:block">
            <ProjectGantt
              projectId={projectId}
              tasks={tasks}
              subtreeProjects={subtreeProjects}
            />
          </div>
        </Section>
      )}

      {topLevelTasks.length > 0 && (
        <Section title="Task Timeline">
          <TaskHeatmap tasks={topLevelTasks} />
        </Section>
      )}
    </Stack>
  );
}
