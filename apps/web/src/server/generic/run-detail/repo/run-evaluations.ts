import { askState } from "@cubby/schemas/kernel/machinery";
import { sql } from "drizzle-orm";

import type { RunEvaluationsOut } from "~/contracts/run-detail.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/** Run detail describes its requested model calls, including shared and replayed Answers. */
export async function readRunEvaluationsByCode(
  db: Database,
  code: string,
  failedOnly: boolean,
): Promise<RunEvaluationsOut> {
  const runId = await resolveOrThrow(db, "run", code);
  const now = new Date();
  const rows = await getDb(db).execute<{
    id: string;
    feature: string;
    state: string;
    attempts: number;
    maxAttempts: number;
    cancelledAt: string | null;
    answeredAt: string | null;
    updatedAt: string;
    error: string | null;
    entity: string | null;
    recordCode: string | null;
  }>(sql`
    SELECT a.id, a.feature, a.state, a.attempts, a."maxAttempts", s."cancelledAt", a."answeredAt", a."updatedAt", a."lastError" AS error,
      e.kind AS entity, e.shortcode AS "recordCode"
    FROM "AskScope" s JOIN "Ask" a ON a.id=s."askId"
    LEFT JOIN "Entity" e ON e.id::text = a.input->${"input"}->>${"recordId"}
    WHERE s."scopeKind"=${"run"} AND s."scopeKey"=${runId} AND s."runId"=${runId}::uuid
    ORDER BY a."updatedAt" DESC, a.id`);
  const byKind = new Map<string, RunEvaluationsOut["byKind"][number]>();
  const recent: RunEvaluationsOut["recent"] = [];
  let pace = 0;
  let lastCompletedAt: string | null = null;
  for (const row of rows.rows) {
    const answered = row.state === askState.enum.answered;
    const failed =
      row.state === askState.enum.unknown || row.attempts >= row.maxAttempts;
    const key = `${row.entity}:${row.feature}`;
    const group = byKind.get(key) ?? {
      entity: row.entity,
      feature: row.feature,
      waiting: 0,
      completed: 0,
      failed: 0,
      obsolete: 0,
      cancelled: 0,
    };
    if (answered) group.completed++;
    else if (row.cancelledAt) group.cancelled++;
    else if (failed) group.failed++;
    else group.waiting++;
    byKind.set(key, group);
    const at = new Date(row.answeredAt ?? row.updatedAt).toISOString();
    if (answered) {
      if (!lastCompletedAt || at > lastCompletedAt) lastCompletedAt = at;
      if (new Date(at).getTime() > now.getTime() - 5 * 60_000) pace++;
    }
    if (
      recent.length < 40 &&
      (failedOnly ? failed : answered || failed || row.cancelledAt)
    )
      recent.push({
        id: row.id,
        entity: row.entity,
        recordCode: row.recordCode,
        feature: row.feature,
        state: row.cancelledAt && !answered ? "cancelled" : row.state,
        candidates: null,
        reason: null,
        error: row.error,
        settledAt: at,
      });
  }
  return {
    measuredAt: now.toISOString(),
    pace: { windowMinutes: 5, completedPerMinute: pace / 5, lastCompletedAt },
    roster: null,
    byKind: [...byKind.values()],
    recent,
  };
}
