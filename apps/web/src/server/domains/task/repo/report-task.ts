import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type {
  EntityReportInput,
  EntityReportOut,
} from "@cubby/schemas/entity-report";
import type { TaskTodayBriefingOut } from "@cubby/schemas/project";
import { z } from "zod";

import { effectiveTaskDueDate } from "~/lib/task-dates";
import type { Database } from "~/server/db";

type ReportBadge = NonNullable<
  Extract<
    EntityReportOut["blocks"][number],
    { kind: "records" }
  >["rows"][number]["badges"]
>[number];

/**
 * A row's status chip from the declared status option: its label and condition tone. The quiet
 * option (Not started) is the expected state and stays unsaid, as list rows already do.
 */
function statusBadges(status: string): ReportBadge[] {
  const option = entityFieldByKey("task", "status")?.control?.options?.find(
    (candidate) => candidate.value === status,
  );
  if (!option) return [{ label: status }];
  if ("quiet" in option && option.quiet) return [];
  const color = "color" in option ? option.color : undefined;
  const tone =
    color === "var(--positive)"
      ? "positive"
      : color === "var(--warning)"
        ? "warning"
        : color === "var(--destructive)"
          ? "destructive"
          : undefined;
  return [tone ? { label: option.label, tone } : { label: option.label }];
}

/** Presentation consumes the bounded SQL projection without fetching an actionable graph. */
export function taskBriefingReport(
  data: TaskTodayBriefingOut,
): EntityReportOut {
  return {
    blocks: [
      {
        kind: "stats",
        figures: [
          { label: "Ready", value: data.nextCount, format: "count" },
          { label: "Later", value: data.laterCount, format: "count" },
          { label: "Blocked", value: data.blockedCount, format: "count" },
          { label: "Overdue", value: data.overdueCount, format: "count" },
          {
            label: "Due this week",
            value: data.dueThisWeekCount,
            format: "count",
          },
        ],
      },
      {
        kind: "records",
        title: "Next tasks",
        empty: "Nothing ready right now. Open work is blocked or set aside.",
        rows: data.next.map((row) => ({
          entity: "task",
          id: row.id,
          title: row.name,
          trailing: effectiveTaskDueDate(row),
          badges: statusBadges(row.status),
          lines:
            row.projectName && row.projectId
              ? [
                  {
                    text: `${row.projectEmoji ? `${row.projectEmoji} ` : ""}${row.projectName}`,
                    tone: "muted",
                    ref: { entity: "project", id: row.projectId },
                  },
                ]
              : [],
          commands: row.commands,
        })),
        footer:
          data.nextCount > data.next.length
            ? `${data.nextCount - data.next.length} more ready`
            : undefined,
      },
    ],
  };
}

export async function taskCollectionReport(
  db: Database,
  input: EntityReportInput,
): Promise<EntityReportOut> {
  const { scope } = input;
  if (scope.kind !== "list" || scope.entity !== "task")
    throw new Error("Expected a Task list report scope.");
  z.strictObject({}).parse(scope.filters);
  const { getTaskTodayBriefing } =
    await import("~/server/domains/task/repo/today-briefing");
  return taskBriefingReport(await getTaskTodayBriefing(db));
}
