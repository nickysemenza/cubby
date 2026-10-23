import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { task } from "~/server/db/schema";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

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

async function loadTaskQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // Keep the declaration's ancestor/project precedence with its SQL owner.
  return unwrapDb(db)
    .select({
      id: task.id,
      shortcode: task.shortcode,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("task", sql`${sql.identifier("Task")}.${sql.identifier("id")}`)}`,
      dueDate: task.dueDate,
      dueEndDate: task.dueEndDate,
      trade: effectiveFieldSql<string | null>("task", "trade", "Task"),
    })
    .from(task)
    .where(
      and(notDeleted(task), sql`${task.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
