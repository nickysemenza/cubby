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
import { jobWaitReason } from "@cubby/schemas/job";
import {
  runStatus,
  runTrigger,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { PENDING_AI_STATES } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import { advisoryXactLock } from "~/server/db/advisory-lock";
import type { Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { aiEvaluation } from "~/server/db/retained-tables";
import type { DrainStore } from "~/server/generic/jobs/drain-store";
import {
  transientRetryAt,
  type DrainItem,
} from "~/server/generic/jobs/drain-store";

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
    isNotNull(aiEvaluation.runAt),
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
      failingSince: null,
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

/**
 * Owe again what a page parked for `runId` as owner or live requester. A Run
 * that is running and still waiting calls this, so its parked evaluation is due
 * whichever way the Run came back.
 */
export async function reviveRunAiEvaluationWork(db: Database, runId: string) {
  const parked = await getDb(db)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      and(
        inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
        isNull(aiEvaluation.runAt),
        sql`(${aiEvaluation.runId} = ${runId}::uuid OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" q
          WHERE q."evaluationId" = ${aiEvaluation.id} AND q."runId" = ${runId}::uuid AND q."cancelledAt" IS NULL))`,
      ),
    );
  await markAiEvaluationWork(
    db,
    parked.map((row) => row.id),
    { revive: true },
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
      failingSince: null,
      leaseToken: null,
      leaseUntil: null,
      waitCause: null,
    })
    .where(where);
}

/**
 * Permit selection: one unit per feature with claimable rows and no live page;
 * priority 0 is member demand. The live page's permit sends the successor.
 */
export const aiEvaluationDue = (prefix: string) =>
  sql`SELECT ${prefix}::text || ':' || ${aiEvaluation.feature} AS unit,
      min(${aiEvaluation.priority}) = 0 AS demand, min(${aiEvaluation.runAt}) AS since
    FROM ${aiEvaluation}
    WHERE ${pendingAndOwed()} AND ${claimable()}
      AND ${aiEvaluation.feature} NOT IN (SELECT live.feature FROM "AiEvaluation" live
        WHERE live."leaseUntil" > now())
    GROUP BY ${aiEvaluation.feature}`;

/** When the next owed evaluation falls due or a lease lapses. */
export const aiEvaluationNext = () =>
  sql`SELECT min(coalesce(${aiEvaluation.leaseUntil}, ${aiEvaluation.runAt})) FROM ${aiEvaluation} WHERE ${pendingAndOwed()}`;

/** Give back whatever this page still holds, unchanged: it stays owed. */
export async function releaseAiEvaluationPage(db: Database, token: string) {
  await getDb(db)
    .update(aiEvaluation)
    .set({ leaseToken: null, leaseUntil: null })
    .where(sql`${aiEvaluation.leaseToken} = ${token}::uuid`);
}

/**
 * A funding change ends evaluations' funding waits now; a source still
 * without capacity defers them again before spending.
 */
const fundingWaitingEvaluations = () =>
  and(
    pendingAndOwed(),
    eq(aiEvaluation.waitCause, jobWaitReason.enum.ai_funding_window),
    sql`${aiEvaluation.runAt} > now()`,
  );

export async function countFundingWaitingEvaluations(db: Database) {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(aiEvaluation)
    .where(fundingWaitingEvaluations());
  return row?.n ?? 0;
}

export async function wakeFundingWaitingEvaluations(db: Database) {
  const woken = await getDb(db)
    .update(aiEvaluation)
    .set({ runAt: sql`now()`, waitCause: null })
    .where(fundingWaitingEvaluations())
    .returning({ id: aiEvaluation.id });
  return woken.length;
}

/** A provider or funding wait stops the feature: its owed rows wait, spending no attempt. */
export async function deferAiEvaluationFeature(
  db: Database,
  feature: string,
  token: string,
  until: Date,
  cause: string,
  error: string,
) {
  await getDb(db)
    .update(aiEvaluation)
    .set({
      runAt: until,
      waitCause: cause,
      error: sql`CASE WHEN ${aiEvaluation.leaseToken} = ${token}::uuid THEN ${error} ELSE ${aiEvaluation.error} END`,
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(aiEvaluation.feature, feature),
        pendingAndOwed(),
        or(
          isNull(aiEvaluation.leaseToken),
          sql`${aiEvaluation.leaseToken} = ${token}::uuid`,
        ),
        sql`${aiEvaluation.runAt} < ${until.toISOString()}::timestamp`,
      ),
    );
}

/**
 * Whether the attempt `token` still holds evaluation `id`. It reads one row by
 * primary key, so a SERIALIZABLE publication takes no relation-wide read on
 * `AiEvaluation` and never depends on another evaluation's lease.
 */
export async function aiEvaluationAttemptHeld(
  db: Database,
  id: string,
  token: string,
) {
  const [row] = await getDb(db)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.id, id),
        aiEvaluationAttemptLive(aiEvaluation.id, token),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Whether this page can still write to at least one row under a live lease.
 * `leaseToken` has no index, so this scans: call it outside SERIALIZABLE transactions.
 */
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
      sql`${aiEvaluation.leaseUntil} > now()`,
    );
  return {
    // One live page per feature, so its publications run one at a time. The
    // lock orders racing claims, and each READ COMMITTED claim sees the lease
    // the previous one committed.
    claim: (db, limit) =>
      repositoryTransactionDatabase(db, async (db) => {
        await advisoryXactLock(getDb(db), "ai-evaluation-page", feature);
        const candidates = getDb(db)
          .select({ id: aiEvaluation.id })
          .from(aiEvaluation)
          .where(
            and(
              sql`${aiEvaluation.feature} = ${feature}`,
              pendingAndOwed(),
              claimable(),
              sql`NOT EXISTS (SELECT 1 FROM "AiEvaluation" live
              WHERE live.feature = ${feature} AND live."leaseUntil" > now())`,
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
            failingSince: aiEvaluation.failingSince,
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
            failingSince: row.failingSince,
          }));
      }),
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
          failingSince: null,
          leaseToken: null,
          leaseUntil: null,
          waitCause: null,
        })
        .where(held(items));
    },
    defer: async (tx, items, error, backoff, transient) => {
      if (!items.length) return;
      await getDb(tx)
        .update(aiEvaluation)
        .set({
          attempts: transient
            ? sql`${aiEvaluation.attempts}`
            : sql`${aiEvaluation.attempts} + 1`,
          failingSince: sql`coalesce(${aiEvaluation.failingSince}, now())`,
          error: error.slice(0, 2000),
          leaseToken: null,
          leaseUntil: null,
          waitCause: null,
          runAt: transient
            ? transientRetryAt(aiEvaluation.failingSince, backoff)
            : sql`now() + least(${backoff.maxMs}::bigint,
            ${backoff.baseMs}::bigint * (2 ^ least(${aiEvaluation.attempts}, 20))::bigint) * interval '1 millisecond'`,
        })
        .where(held(items));
    },
  };
};
