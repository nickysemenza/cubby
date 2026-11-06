/**
 * What the AI evaluation drain owes, on `AiEvaluation` itself: `runAt` is set while
 * an evaluation is owed and null once it settled or parked. A page holds its rows
 * under one `leaseToken`, which is also the attempt token its writes check. There is
 * no queue row and no heartbeat; a consumer cannot outlive `AI_EVALUATION_LEASE_MS`,
 * so a lapsed lease means its invocation is gone. A mark never takes a held lease,
 * because that page may be paying the provider and no other page may pay beside it:
 * new input makes the lease stale, so the page's writes fail until it releases the row.
 * Marking wakes nothing: repository callers cannot reach the queue. A round's end
 * wakes for what is due, a Run launch wakes for itself, and the hourly cron is behind both.
 */
import {
  runStatus,
  runTrigger,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import {
  and,
  asc,
  gt,
  inArray,
  isNull,
  min,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { PENDING_AI_STATES } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import type { Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { aiEvaluation } from "~/server/db/retained-tables";
import type { DrainStore } from "~/server/generic/jobs/drain-store";
import type { DrainItem } from "~/server/generic/jobs/drain-store";

/** Items name evaluations; a page serves one feature. */
const AI_EVALUATION_TARGET = "ai.evaluation";
export const aiEvaluationPageKey = (feature: string) =>
  `ai-evaluation:${feature}`;

/** Longer than the 15 minutes a queue consumer can run. */
const AI_EVALUATION_LEASE_MS = 16 * 60_000;

/** The attempt `token` still holds evaluation `id` under a live lease. */
export const aiEvaluationAttemptLive = (
  id: SQLWrapper | string,
  token: string,
) =>
  sql`EXISTS (SELECT 1 FROM "AiEvaluation" held
    WHERE held.id = ${typeof id === "string" ? sql`${id}::uuid` : sql`${id}`}
      AND held."leaseToken" = ${token}::uuid
      AND NOT held."leaseStale"
      AND held."leaseUntil" > now())`;

const pendingAndOwed = () =>
  and(
    inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
    sql`${aiEvaluation.runAt} IS NOT NULL`,
  );
const claimable = () => sql`(
  ${aiEvaluation.runAt} <= now()
  AND (${aiEvaluation.leaseUntil} IS NULL OR ${aiEvaluation.leaseUntil} <= now())
)`;

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
 * Owe pending evaluations in the caller's transaction, for input that changed: an
 * attempt in flight on the old input keeps its lease but can no longer write. `revive`
 * touches only evaluations that are parked or whose demand became more urgent; the
 * input is the same, so an attempt in flight still settles them.
 */
export async function markAiEvaluationWork(
  db: Database,
  ids: readonly string[],
  { revive = false, readyAt }: { revive?: boolean; readyAt?: Date } = {},
) {
  if (!ids.length) return;
  await getDb(db)
    .update(aiEvaluation)
    .set({
      runAt: readyAt ?? sql`now()`,
      priority: sql`CASE WHEN ${aiEvaluation.runAt} IS NOT NULL
        THEN least(${aiEvaluation.priority}, ${demandPriority}) ELSE ${demandPriority} END`,
      attempts: 0,
      error: null,
      waitCause: null,
      ...(revive
        ? {}
        : { leaseStale: sql`${aiEvaluation.leaseToken} IS NOT NULL` }),
    })
    .where(
      and(
        inArray(aiEvaluation.id, [...ids]),
        inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
        revive
          ? or(
              isNull(aiEvaluation.runAt),
              gt(aiEvaluation.priority, demandPriority),
            )
          : undefined,
      ),
    );
}

/** Hold not-yet-claimed evaluations until `until`; an attempt already holding one keeps it. */
export async function postponeAiEvaluationWork(
  db: Database,
  ids: readonly string[],
  until: Date,
) {
  if (!ids.length) return;
  await getDb(db)
    .update(aiEvaluation)
    .set({ runAt: until })
    .where(
      and(
        inArray(aiEvaluation.id, [...ids]),
        pendingAndOwed(),
        isNull(aiEvaluation.leaseToken),
      ),
    );
}

/** Stop owing evaluations a Run's cancellation settled. */
export async function dropAiEvaluationWork(db: Database, where: SQL) {
  await getDb(db)
    .update(aiEvaluation)
    .set({
      runAt: null,
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
      waitCause: null,
    })
    .where(where);
}

/** Features with claimable evaluations, most urgent first. */
export async function dueAiEvaluationFeatures(db: Database) {
  const rows = await getDb(db)
    .select({ feature: aiEvaluation.feature })
    .from(aiEvaluation)
    .where(and(pendingAndOwed(), claimable()))
    .groupBy(aiEvaluation.feature)
    .orderBy(min(aiEvaluation.priority), min(aiEvaluation.runAt));
  return rows.map((row) => row.feature);
}

/** When the next owed evaluation falls due or a lease lapses, if later than now. */
export async function nextAiEvaluationDue(db: Database): Promise<Date | null> {
  const [row] = await getDb(db)
    .select({
      // Epoch milliseconds: the driver would read a zoneless timestamp as local time.
      at: sql<
        number | null
      >`(extract(epoch FROM min(coalesce(${aiEvaluation.leaseUntil}, ${aiEvaluation.runAt}))) * 1000)::float8`,
    })
    .from(aiEvaluation)
    .where(pendingAndOwed());
  return row?.at == null ? null : new Date(row.at);
}

/** Give back whatever this page still holds, unchanged: it stays owed. */
export async function releaseAiEvaluationPage(db: Database, token: string) {
  await getDb(db)
    .update(aiEvaluation)
    .set({ leaseToken: null, leaseUntil: null })
    .where(sql`${aiEvaluation.leaseToken} = ${token}::uuid`);
}

/** A provider or funding wait stops the feature: its owed rows wait, spending no attempt. */
export async function deferAiEvaluationFeature(
  db: Database,
  feature: string,
  token: string,
  until: Date,
  cause: string,
) {
  await getDb(db)
    .update(aiEvaluation)
    .set({
      runAt: until,
      waitCause: cause,
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        sql`${aiEvaluation.feature} = ${feature}`,
        pendingAndOwed(),
        or(
          isNull(aiEvaluation.leaseToken),
          sql`${aiEvaluation.leaseToken} = ${token}::uuid`,
        ),
        sql`${aiEvaluation.runAt} < ${until.toISOString()}::timestamp`,
      ),
    );
}

/** Whether this page can still write to at least one row under a live lease. */
export async function aiEvaluationPageHeld(db: Database, token: string) {
  const [row] = await getDb(db)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      and(
        sql`${aiEvaluation.leaseToken} = ${token}::uuid`,
        sql`NOT ${aiEvaluation.leaseStale}`,
        sql`${aiEvaluation.leaseUntil} > now()`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Hold items waiting on upstream coverage, without spending an attempt. */
export async function waitAiEvaluations(
  tx: Database,
  items: readonly DrainItem[],
  token: string,
  cause: string,
  delayMs: number,
) {
  if (!items.length) return;
  await getDb(tx)
    .update(aiEvaluation)
    .set({
      runAt: new Date(Date.now() + delayMs),
      waitCause: cause,
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        inArray(
          aiEvaluation.id,
          items.map((item) => item.ref),
        ),
        sql`${aiEvaluation.leaseToken} = ${token}::uuid`,
        sql`NOT ${aiEvaluation.leaseStale}`,
      ),
    );
}

/** One page's view of a feature's owed evaluations, claimed under `token`. */
export const aiEvaluationStore = (
  feature: string,
  token: string,
): DrainStore => {
  const held = (items: readonly DrainItem[]) =>
    and(
      inArray(
        aiEvaluation.id,
        items.map((item) => item.ref),
      ),
      sql`${aiEvaluation.leaseToken} = ${token}::uuid`,
      sql`NOT ${aiEvaluation.leaseStale}`,
    );
  return {
    claim: async (db, limit) => {
      const candidates = getDb(db)
        .select({ id: aiEvaluation.id })
        .from(aiEvaluation)
        .where(
          and(
            sql`${aiEvaluation.feature} = ${feature}`,
            pendingAndOwed(),
            claimable(),
          ),
        )
        .orderBy(
          asc(aiEvaluation.priority),
          asc(aiEvaluation.runAt),
          asc(aiEvaluation.id),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
      const rows = await getDb(db)
        .update(aiEvaluation)
        .set({
          leaseToken: token,
          leaseUntil: sql`now() + ${AI_EVALUATION_LEASE_MS} * interval '1 millisecond'`,
          leaseStale: false,
          // A lapsed lease is an attempt spent, so a crash loop still exhausts.
          attempts: sql`${aiEvaluation.attempts} + CASE WHEN ${aiEvaluation.leaseUntil} IS NULL THEN 0 ELSE 1 END`,
          waitCause: null,
        })
        .where(inArray(aiEvaluation.id, candidates))
        .returning({
          id: aiEvaluation.id,
          priority: aiEvaluation.priority,
          attempts: aiEvaluation.attempts,
          runAt: aiEvaluation.runAt,
        });
      return rows
        .sort(
          (a, b) =>
            a.priority - b.priority ||
            (a.runAt?.getTime() ?? 0) - (b.runAt?.getTime() ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .map((row): DrainItem => ({
          target: AI_EVALUATION_TARGET,
          ref: row.id,
          ticket: 0,
          priority: row.priority,
          attempts: row.attempts,
        }));
    },
    lock: async (tx, items) => {
      if (!items.length) return [];
      const rows = await getDb(tx)
        .select({ id: aiEvaluation.id })
        .from(aiEvaluation)
        .where(held(items))
        .orderBy(asc(aiEvaluation.id))
        .for("update");
      const current = new Set(rows.map((row) => row.id));
      return items.filter((item) => current.has(item.ref));
    },
    clear: async (tx, items) => {
      if (!items.length) return;
      await getDb(tx)
        .update(aiEvaluation)
        .set({
          runAt: null,
          attempts: 0,
          leaseToken: null,
          leaseUntil: null,
          waitCause: null,
        })
        .where(held(items));
    },
    defer: async (tx, items, error, backoff) => {
      if (!items.length) return;
      await getDb(tx)
        .update(aiEvaluation)
        .set({
          attempts: sql`${aiEvaluation.attempts} + 1`,
          error: error.slice(0, 2000),
          leaseToken: null,
          leaseUntil: null,
          waitCause: null,
          runAt: sql`now() + least(${backoff.maxMs}::bigint,
            ${backoff.baseMs}::bigint * (2 ^ least(${aiEvaluation.attempts}, 20))::bigint) * interval '1 millisecond'`,
        })
        .where(held(items));
    },
    nextReadyAt: nextAiEvaluationDue,
  };
};
