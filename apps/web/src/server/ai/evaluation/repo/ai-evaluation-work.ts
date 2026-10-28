/**
 * The producer side of AI evaluation drains: one `ai.evaluation` drain Job per
 * feature over evaluation work items. Repository-owned callers mark work here
 * without reaching Run wake or Worker composition.
 */
import {
  runStatus,
  runTrigger,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import { and, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { PENDING_AI_STATES } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import type { Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { aiEvaluation } from "~/server/db/retained-tables";
import {
  markWork,
  workAttemptLive,
  workAttemptToken,
  workPriority,
  type Drain,
} from "~/server/generic/jobs/repo/work-items";

/** Work items name evaluations; one `ai.evaluation` drain Job serves each feature. */
export const AI_EVALUATION_TARGET = "ai.evaluation";
export const aiEvaluationDrain = (feature: string): Drain => ({
  key: `ai-evaluation:${feature}`,
  kind: "ai.evaluation",
});

/** An evaluation attempt is its drain item's attempt (`workAttemptToken`). */
export const aiEvaluationAttemptToken = workAttemptToken;

/** The attempt `token` still holds evaluation `id`'s item through a live drain lease. */
export const aiEvaluationAttemptLive = (
  id: SQLWrapper | string,
  token: string,
) =>
  workAttemptLive(
    AI_EVALUATION_TARGET,
    typeof id === "string" ? sql`${id}::uuid` : sql`${id}`,
    token,
  );

/**
 * Priority 0 is member demand: the owner or a live requester is a running,
 * member-visible Run nobody scheduled. Everything else is automatic (1).
 */
// includes-deleted: priority only orders work; publication rechecks live Runs.
const demandPriority = sql<number>`CASE WHEN EXISTS (
  SELECT 1 FROM "Run" r
   WHERE r.status = ${runStatus.enum.running}
     AND r.trigger <> ${runTrigger.enum.scheduled}
     AND r.purpose IN (${sql.join(
       VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
       sql`, `,
     )})
     AND (r.id = ${aiEvaluation.runId} OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" q
       WHERE q."evaluationId" = ${aiEvaluation.id} AND q."runId" = r.id AND q."cancelledAt" IS NULL))
) THEN 0 ELSE 1 END`;

/**
 * Mark pending evaluations on their feature drains in the caller's
 * transaction. `revive` re-marks only evaluations without an item or whose
 * demand became more urgent, so joining demand never supersedes an attempt
 * without cause.
 */
export async function markAiEvaluationWork(
  db: Database,
  ids: readonly string[],
  { revive = false, readyAt }: { revive?: boolean; readyAt?: Date } = {},
) {
  if (!ids.length) return;
  const owed: SQL = workPriority(AI_EVALUATION_TARGET, sql`${aiEvaluation.id}`);
  const rows = await getDb(db)
    .select({
      id: aiEvaluation.id,
      feature: aiEvaluation.feature,
      priority: sql<number>`${demandPriority}::int`,
    })
    .from(aiEvaluation)
    .where(
      and(
        inArray(aiEvaluation.id, [...ids]),
        inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
        revive
          ? or(sql`${owed} IS NULL`, sql`${owed} > ${demandPriority}`)
          : undefined,
      ),
    );
  const byFeature = new Map<string, typeof rows>();
  for (const row of rows)
    byFeature.set(row.feature, [...(byFeature.get(row.feature) ?? []), row]);
  for (const [feature, items] of [...byFeature].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    await markWork(
      db,
      aiEvaluationDrain(feature),
      items.map((row) => ({
        target: AI_EVALUATION_TARGET,
        ref: row.id,
        priority: row.priority,
      })),
      { readyAt },
    );
}
