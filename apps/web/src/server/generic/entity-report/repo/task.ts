import type { EntityReportOut } from "@cubby/schemas/entity-report";
import type { TaskTodayBriefingOut } from "@cubby/schemas/project";

import { effectiveTaskDueDate } from "~/lib/task-dates";

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
          badges: [{ label: row.status.replaceAll("_", " ") }],
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
        })),
        footer:
          data.nextCount > data.next.length
            ? `${data.nextCount - data.next.length} more ready`
            : undefined,
      },
    ],
  };
}
