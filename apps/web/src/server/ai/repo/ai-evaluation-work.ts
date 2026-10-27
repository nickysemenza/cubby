/**
 * The producer side of AI evaluation drains: one `ai.evaluation` drain Job per
 * feature over evaluation work items. Repository-owned callers mark work here
 * without reaching Run wake or Worker composition.
 */
import { jobState } from "@cubby/schemas/job";
import {
  runStatus,
  runTrigger,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import { sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db/database";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { markWork, type Drain } from "~/server/generic/jobs/repo/work-items";

/** Work items name evaluations; one `ai.evaluation` drain Job serves each feature. */
export const AI_EVALUATION_TARGET = "ai.evaluation";
export const aiEvaluationDrain = (feature: string): Drain => ({
  key: `ai-evaluation:${feature}`,
  kind: "ai.evaluation",
});

/**
 * One attempt is the drain lease plus the item's ticket: a re-mark (changed
 * input, new demand) or a lost lease makes the attempt obsolete.
 */
export const aiEvaluationAttemptToken = (leaseToken: string, ticket: number) =>
  `${leaseToken}/${ticket}`;

/** The attempt `token` still holds evaluation `id`'s item through a live drain lease. */
export const aiEvaluationAttemptLive = (
  id: SQLWrapper | string,
  token: string,
) => {
  const ref = typeof id === "string" ? sql`${id}::uuid` : id;
  return sql`EXISTS (SELECT 1 FROM "WorkItem" w JOIN "Job" j ON j.key = w.drain
    WHERE w.target = ${AI_EVALUATION_TARGET} AND w.ref = ${ref}
      AND w.ticket = split_part(${token}, '/', 2)::bigint
      AND j.state = ${jobState.enum.running} AND j."leaseToken" = split_part(${token}, '/', 1)::uuid
      AND j."leaseExpiresAt" > now())`;
};

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
     AND (r.id = e."runId" OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" q
       WHERE q."evaluationId" = e.id AND q."runId" = r.id AND q."cancelledAt" IS NULL))
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
  const result = await getDb(db).execute(sql`
    SELECT e.id::text AS id, e.feature, ${demandPriority} AS priority
      FROM "AiEvaluation" e
      LEFT JOIN "WorkItem" w ON w.target = ${AI_EVALUATION_TARGET} AND w.ref = e.id
     WHERE e.id = ANY(${uuidArrayParam(ids)})
       AND e.state IN (${sql.join(
         PENDING_AI_STATES.map((state) => sql`${state}`),
         sql`, `,
       )})
       ${revive ? sql`AND (w.ref IS NULL OR w.priority > ${demandPriority})` : sql``}`);
  const rows = z
    .array(
      z.object({
        id: z.string(),
        feature: z.string(),
        priority: z.coerce.number(),
      }),
    )
    .parse(result.rows);
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
