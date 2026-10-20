import type {
  EntityReportInput,
  EntityReportOut,
  ReportBlock,
} from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { projectDashboardFiltersSchema } from "@cubby/schemas/project";
import { z } from "zod";

import { formatCurrency } from "~/lib/number-format";
import type { Database } from "~/server/db";
import { projectPortfolioAnalytics } from "~/server/domains/project/repo/portfolio-analytics";
import { getTaskTodayBriefing } from "~/server/domains/task/repo/today-briefing";

import { taskBriefingReport } from "./task";

/** Scoped reports validate their own supported filters instead of ignoring a wider list scope. */
export async function buildCollectionReport(
  db: Database,
  input: EntityReportInput,
): Promise<EntityReportOut> {
  const { scope } = input;
  if (scope.kind === "record")
    throw new Error("Expected a collection report scope.");
  if (input.cursor !== undefined)
    throw new Error(
      `${input.slot} does not support a collection report cursor.`,
    );
  if (input.slot === "project.analytics" && scope.entity === "project") {
    const filters =
      scope.kind === "list"
        ? projectDashboardFiltersSchema.strict().parse(scope.filters)
        : {};
    const ids =
      scope.kind === "selection"
        ? [...new Set(scope.ids.map((id) => parseShortcodeFor("project", id)))]
        : undefined;
    const data = await projectPortfolioAnalytics(db, filters, ids);
    const roots = data.costVsEstimate.filter((row) => row.isScopeRoot);
    const estimates = roots.flatMap((row) =>
      row.estimate === null ? [] : [row.estimate],
    );
    const total = (field: "actual" | "committed") =>
      roots.reduce((sum, row) => sum + row[field], 0);
    const blocks: ReportBlock[] = [
      {
        kind: "stats",
        title: "Portfolio",
        figures: [
          {
            label: "Projects",
            value: data.costVsEstimate.length,
            format: "count",
          },
          {
            label: "Estimate",
            value: estimates.length
              ? estimates.reduce((sum, value) => sum + value, 0)
              : null,
            format: "money",
          },
          { label: "Actual", value: total("actual"), format: "money" },
          { label: "Committed", value: total("committed"), format: "money" },
        ],
      },
      {
        kind: "table",
        title: "Cost vs estimate",
        columns: ["Project", "Actual", "Committed", "Estimate"],
        empty: "No projects in this scope.",
        rows: data.costVsEstimate.map((row) => ({
          id: row.projectId,
          cells: [
            row.projectName,
            formatCurrency(row.actual),
            formatCurrency(row.committed),
            row.estimate === null ? "—" : formatCurrency(row.estimate),
          ],
          ref: { entity: "project", id: row.projectId },
        })),
      },
      {
        kind: "chart",
        title: "Spending by project",
        mark: "bar",
        format: "money",
        series: data.spendingByProject.map((row) => ({
          label: row.projectName,
          value: row.spend,
          ref: { entity: "project", id: row.projectId },
        })),
      },
      {
        kind: "table",
        title: "Monthly spending",
        columns: ["Month", "Actual", "Committed", "Credits", "Net", "Expenses"],
        rows: data.monthlySpend.map((row) => ({
          id: row.month,
          cells: [
            row.month,
            formatCurrency(row.actual),
            formatCurrency(row.committed),
            formatCurrency(-row.credits),
            formatCurrency(row.net),
            String(row.count),
          ],
        })),
      },
      {
        kind: "table",
        title: "Planned vs actual",
        columns: ["Month", "Planned", "Actual"],
        rows: data.plannedVsActual.map((row) => ({
          id: row.month,
          cells: [
            row.month,
            formatCurrency(row.planned),
            formatCurrency(row.actual),
          ],
        })),
      },
      {
        kind: "table",
        title: "Spend by trade",
        columns: ["Trade", "Actual", "Committed", "Credits", "Net", "Expenses"],
        rows: data.tradeActivity.map((row) => ({
          id: row.trade ?? "unassigned",
          cells: [
            row.trade ?? "Unassigned",
            formatCurrency(row.actual),
            formatCurrency(row.committed),
            formatCurrency(-row.credits),
            formatCurrency(row.net),
            String(row.count),
          ],
        })),
      },
      {
        kind: "chart",
        title: "Open tasks by project",
        mark: "bar",
        format: "count",
        series: data.taskHeatmap.map((row) => ({
          label: row.projectName,
          value: row.openTaskCount,
          ref: { entity: "project", id: row.projectId },
        })),
      },
    ];
    return { blocks };
  }
  if (
    input.slot === "task.briefing" &&
    scope.kind === "list" &&
    scope.entity === "task"
  ) {
    z.strictObject({}).parse(scope.filters);
    const data = await getTaskTodayBriefing(db);
    return taskBriefingReport(data);
  }
  throw new Error(
    `${input.slot} does not support this ${scope.kind} ${scope.entity} report scope.`,
  );
}
