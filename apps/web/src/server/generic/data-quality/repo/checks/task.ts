import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { task } from "~/server/db/schema";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadTaskQualityRecords = qualityCheck.records("task", task, {
  dueDate: task.dueDate,
  dueEndDate: task.dueEndDate,
  trade: effectiveFieldSql<string | null>("task", "trade", "Task"),
});

/** Bump when the rules or their declared scoring metadata change. */
const TASK_QUALITY_RULES_VERSION = 1;
type TaskQualityRecord = Awaited<
  ReturnType<typeof loadTaskQualityRecords>
>[number];
const observed = qualityCheck.observed<TaskQualityRecord>;

export const taskChecks = defineStoredEntityChecks({
  entity: "task",
  table: task,
  rulesVersion: TASK_QUALITY_RULES_VERSION,
  load: loadTaskQualityRecords,
  checks: {
    task_display_image: qualityCheck.hasImage,
    task_due_range: qualityCheck.when(
      (r: TaskQualityRecord) => r.dueDate !== null && r.dueEndDate !== null,
      observed((r) => r.dueEndDate! >= r.dueDate!),
    ),
    task_trade: observed((r) => r.trade !== null),
  },
});
