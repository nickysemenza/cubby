import {
  aiRefreshProgress,
  aiProvenance,
  aiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { jobState } from "@cubby/schemas/job";
import {
  runStatus,
  runTrigger,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";

import { dependenciesCurrent } from "~/server/ai/policy/refresh-manifest";
import {
  aiExecutionOwner,
  liveAiRequestRun,
  PENDING_AI_STATES,
} from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import {
  getDb,
  withTransactionDatabase,
  runAfterCommit,
} from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { repositoryBeforeCommit } from "~/server/db/repository-access.boundary";
import { aiEvaluation, aiEvaluationRequest, run } from "~/server/db/schema";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import {
  assertCurrentJob,
  currentJobExecution,
} from "~/server/generic/jobs/repo/execution";
import {
  markWork,
  postponeWork,
  type Drain,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";

import { readAiRefreshActivation } from "./ai-refresh";
import type {
  EvaluationPageTarget,
  EvaluationPagePublication,
} from "./evaluation-page";

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

/** A newer attempt or a settled state owns the evaluation; this attempt writes nothing. */
export class AiEvaluationAttemptObsoleteError extends Error {
  constructor() {
    super("AI evaluation attempt is obsolete");
  }
}

/** No live Run authorizes the evaluation; its item parks until a requester resumes. */
export class AiEvaluationUnauthorizedError extends Error {
  constructor() {
    super("No live requester authorizes AI evaluation");
  }
}

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

/** Hold not-yet-claimed items until `until`; an attempt already holding one keeps it. */
export async function postponeAiEvaluationWork(
  db: Database,
  ids: readonly string[],
  until: Date,
) {
  if (!ids.length) return;
  const result = await getDb(db).execute(sql`
    SELECT target, ref::text AS ref, ticket, priority, attempts FROM "WorkItem"
     WHERE target = ${AI_EVALUATION_TARGET} AND ref = ANY(${uuidArrayParam(ids)})`);
  const items = z
    .array(
      z.object({
        target: z.string(),
        ref: z.string(),
        ticket: z.coerce.number(),
        priority: z.coerce.number(),
        attempts: z.coerce.number(),
      }),
    )
    .parse(result.rows);
  await postponeWork(db, items, until);
}

export async function readAiEvaluations(db: Database, ids: readonly string[]) {
  if (!ids.length) return [];
  return getDb(db)
    .select()
    .from(aiEvaluation)
    .where(inArray(aiEvaluation.id, [...ids]));
}

export type ClaimedAiEvaluation = typeof aiEvaluation.$inferSelect & {
  attemptToken: string;
  attempts: number;
};

/** Bind one drain item to its live owner; the drain's lease fences every later write. */
export async function claimAiEvaluation(
  db: Database,
  item: WorkItem,
  requestingRunId?: string,
): Promise<ClaimedAiEvaluation | null> {
  const execution = currentJobExecution();
  if (!execution || execution.claim.kind !== "ai.evaluation")
    throw new Error("AI evaluation execution requires its drain Job claim");
  return withTransactionDatabase(db, async (tx) => {
    await assertCurrentJob(tx);
    const [existing] = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, item.ref));
    if (!existing || !PENDING_AI_STATES.includes(existing.state)) return null;
    if (execution.claim.key !== aiEvaluationDrain(existing.feature).key)
      throw new Error("AI evaluation item belongs to another drain");
    if (
      existing.executionKind === "ai_refresh" &&
      !(await readAiRefreshActivation(tx))?.enabled
    )
      throw new JobDeferredError(
        "Automatic AI refresh is disabled",
        new Date(Date.now() + 120_000),
        "provider_capacity",
      );
    const owner = await aiExecutionOwner(tx, existing, requestingRunId);
    if (
      !owner ||
      (existing.executionKind === "ai_refresh" &&
        (owner.status !== "running" || owner.deletedAt || owner.retiredAt))
    )
      throw new AiEvaluationUnauthorizedError();
    const [row] = await getDb(tx)
      .update(aiEvaluation)
      .set({ runId: owner.id, updatedAt: new Date() })
      .where(
        and(
          eq(aiEvaluation.id, item.ref),
          inArray(aiEvaluation.state, PENDING_AI_STATES),
        ),
      )
      .returning();
    return row
      ? {
          ...row,
          attemptToken: aiEvaluationAttemptToken(
            execution.claim.leaseToken,
            item.ticket,
          ),
          attempts: item.attempts,
        }
      : null;
  });
}

/** The active manifest and Run state are read in the business-write transaction. */
export async function guardAiEvaluation(
  tx: Database,
  id: string,
  token: string,
) {
  await (
    await import("~/server/workflows/runs/execution")
  ).assertWorkflowEffect(tx);
  const execution = currentJobExecution();
  if (!execution || !token.startsWith(`${execution.claim.leaseToken}/`))
    throw new AiEvaluationAttemptObsoleteError();
  const [read] = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, id));
  if (!read) throw new AiEvaluationAttemptObsoleteError();
  const activation =
    read.executionKind === "ai_refresh"
      ? await readAiRefreshActivation(tx)
      : null;
  // Match cancellation's Run-before-item lock order. A shared item's original
  // requester may stop while another live requester still wants publication.
  const owners = await getDb(tx)
    .select({
      id: run.id,
      status: run.status,
      deletedAt: run.deletedAt,
      retiredAt: run.retiredAt,
    })
    .from(run)
    .where(
      read.executionKind === "ai_refresh"
        ? eq(run.id, read.runId)
        : or(eq(run.id, read.runId), liveAiRequestRun(id)),
    )
    .orderBy(run.id)
    .for("no key update");
  const [row] = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.id, id),
        inArray(aiEvaluation.state, PENDING_AI_STATES),
        aiEvaluationAttemptLive(aiEvaluation.id, token),
      ),
    )
    .for("update");
  if (!row) throw new AiEvaluationAttemptObsoleteError();
  const owner = owners.find((entry) => entry.id === row.runId);
  if (
    !owner ||
    !owners.some(
      (entry) =>
        entry.status === "running" && !entry.deletedAt && !entry.retiredAt,
    )
  )
    throw new AiEvaluationUnauthorizedError();
  if (row.executionKind === "ai_refresh") {
    if (!activation?.enabled)
      throw new JobDeferredError(
        "Automatic AI refresh is disabled",
        new Date(Date.now() + 120_000),
        "provider_capacity",
      );
    if (
      !dependenciesCurrent(
        aiProvenance.parse(row.provenance),
        activation.manifest,
      )
    )
      throw new Error("AI evaluation generation is obsolete");
  }
  return { row, target: aiEvaluationTarget.parse(row.target) };
}

/** Held only for final writes/commit, never snapshot preparation or requester wakeup. */
async function fenceAiEvaluationActivation(
  tx: Database,
  rows: readonly Pick<
    typeof aiEvaluation.$inferSelect,
    "executionKind" | "provenance"
  >[],
) {
  const refresh = rows.filter((row) => row.executionKind === "ai_refresh");
  if (!refresh.length) return;
  const activation = await readAiRefreshActivation(tx, "share");
  if (!activation?.enabled)
    throw new JobDeferredError(
      "Automatic AI refresh is disabled",
      new Date(Date.now() + 120_000),
      "provider_capacity",
    );
  if (
    refresh.some(
      (row) =>
        !dependenciesCurrent(
          aiProvenance.parse(row.provenance),
          activation.manifest,
        ),
    )
  )
    throw new Error("AI evaluation generation is obsolete");
}

export async function completeAiEvaluation(
  tx: Database,
  id: string,
  token: string,
  receipt: unknown,
  state: "completed" | "blocked" | "obsolete" = "completed",
) {
  const { row } = await guardAiEvaluation(tx, id, token);
  await settleAiEvaluations(tx, [
    { evaluationId: id, state, receipt: z.json().parse(receipt) },
  ]);
  await fenceAiEvaluationActivation(tx, [row]);
}

/**
 * Domain outcomes for evaluations whose locks the caller already holds:
 * receipts reach live requests and each requester wakes once after commit.
 */
export async function settleAiEvaluations(
  tx: Database,
  publications: readonly EvaluationPagePublication[],
) {
  if (!publications.length) return;
  const values = sql.join(
    publications.map(
      (entry) =>
        sql`(${entry.evaluationId}::uuid, ${entry.state}::text, ${JSON.stringify(z.json().parse(entry.receipt))}::jsonb)`,
    ),
    sql`, `,
  );
  await getDb(tx)
    .update(aiEvaluation)
    .set({
      state: sql`page.state`,
      receipt: sql`page.receipt`,
      error: null,
      updatedAt: new Date(),
    })
    .from(sql`(VALUES ${values}) page(id, state, receipt)`)
    .where(sql`${aiEvaluation.id}=page.id`);
  await getDb(tx)
    .update(aiEvaluationRequest)
    .set({ receipt: sql`page.receipt` })
    .from(sql`(VALUES ${values}) page(id, state, receipt)`)
    .where(
      and(
        sql`${aiEvaluationRequest.evaluationId}=page.id`,
        isNull(aiEvaluationRequest.cancelledAt),
        sql`${aiEvaluationRequest.receipt}->>'retryEvaluationId' IS NULL`,
      ),
    );
  await (
    await import("~/server/workflows/runs/wake")
  ).wakeAiEvaluationRequesters(
    tx,
    publications.map((entry) => entry.evaluationId),
  );
}

/** A single evaluation's guarded write; `continue` keeps it pending for more units. */
export async function publishAiEvaluation<T>(
  db: Database,
  id: string,
  token: string,
  work: (tx: Database) => Promise<T>,
  settlement: "complete" | "continue" = "complete",
) {
  return withTransactionDatabase(
    db,
    async (tx) => {
      const { row } = await guardAiEvaluation(tx, id, token);
      const result = await work(tx);
      // Acquire the global fence only after business work. SERIALIZABLE rejects
      // activation changed since this transaction's snapshot; the share lock
      // prevents deactivation between this check and commit.
      if (settlement === "complete")
        await settleAiEvaluations(tx, [
          {
            evaluationId: id,
            state: "completed",
            receipt: z.json().parse(result),
          },
        ]);
      await fenceAiEvaluationActivation(tx, [row]);
      return result;
    },
    { isolationLevel: "serializable" },
  );
}

/** Stores a paid result before publication so a later failure reuses it; false when obsolete. */
export async function storeAiEvaluationResult(
  db: Database,
  item: Pick<ClaimedAiEvaluation, "id" | "attemptToken">,
  result: (typeof aiEvaluation.$inferSelect)["result"],
) {
  return withTransactionDatabase(db, async (tx) => {
    await guardAiEvaluation(tx, item.id, item.attemptToken);
    const [stored] = await getDb(tx)
      .update(aiEvaluation)
      .set({ state: "result_ready", result })
      .where(
        and(
          eq(aiEvaluation.id, item.id),
          inArray(aiEvaluation.state, PENDING_AI_STATES),
        ),
      )
      .returning({ id: aiEvaluation.id });
    return Boolean(stored);
  });
}

export function aiEvaluationProgress(
  rows: readonly (typeof aiEvaluation.$inferSelect)[],
  attempt: number,
) {
  const current = rows.filter(
    (row) =>
      !z.object({ retryEvaluationId: z.uuid() }).safeParse(row.receipt).success,
  );
  const count = (state: (typeof aiEvaluation.$inferSelect)["state"]) =>
    current.filter((row) => row.state === state).length;
  return aiRefreshProgress.parse({
    attempt,
    selected: current.length,
    queued: count("queued"),
    resultReady: count("result_ready"),
    completed: count("completed"),
    blocked: count("blocked"),
    failed: count("failed"),
    obsolete: count("obsolete"),
    cancelled: count("cancelled"),
    errors: current
      .flatMap((row) => (row.error ? [row.error] : []))
      .slice(0, 10),
  });
}

/** The authorizing Run per evaluation, including shared demand. */
export async function aiEvaluationAuthorizations(
  db: Database,
  evaluations: readonly Pick<
    typeof aiEvaluation.$inferSelect,
    "id" | "runId" | "executionKind"
  >[],
  lock: "share" | false = "share",
) {
  if (!evaluations.length) return new Map<string, typeof run.$inferSelect>();
  const ids = evaluations.map((item) => item.id);
  const query = getDb(db)
    .select()
    .from(run)
    .where(
      or(
        inArray(
          run.id,
          evaluations.map((item) => item.runId),
        ),
        sql`EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."runId"=${run.id} AND r."evaluationId" = ANY(${uuidArrayParam(ids)}) AND r."cancelledAt" IS NULL)`,
      ),
    )
    .orderBy(run.id);
  const owners = await (lock ? query.for(lock) : query);
  const requests = await getDb(db)
    .select()
    .from(aiEvaluationRequest)
    .where(
      and(
        inArray(aiEvaluationRequest.evaluationId, ids),
        isNull(aiEvaluationRequest.cancelledAt),
      ),
    );
  const active = new Map(
    owners
      .filter(
        (owner) =>
          owner.status === "running" && !owner.deletedAt && !owner.retiredAt,
      )
      .map((owner) => [owner.id, owner]),
  );
  return new Map(
    evaluations.flatMap((item) => {
      const ownRequest = requests.find(
        (request) =>
          request.evaluationId === item.id && request.runId === item.runId,
      );
      const owner =
        item.executionKind === "ai_refresh"
          ? active.get(item.runId)
          : ((ownRequest ? active.get(item.runId) : undefined) ??
            requests
              .filter((request) => request.evaluationId === item.id)
              .map((request) => active.get(request.runId))
              .find((value) => value !== undefined));
      return owner ? [[item.id, owner] as const] : [];
    }),
  );
}

/**
 * Run -> slot -> evaluation, matching scheduling and cancellation; the drain
 * locks the items next and the Job row last.
 */
export async function lockAiEvaluationPage(
  tx: Database,
  targets: readonly EvaluationPageTarget[],
) {
  if (!targets.length) return;
  await aiEvaluationAuthorizations(
    tx,
    targets.map((entry) => entry.evaluation),
  );
  const keys = [
    ...new Set(targets.map((entry) => entry.evaluation.slotKey)),
  ].sort();
  await getDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest(ARRAY[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]) key ORDER BY key`,
  );
  await getDb(tx)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      inArray(
        aiEvaluation.id,
        targets.map((entry) => entry.evaluation.id),
      ),
    )
    .orderBy(aiEvaluation.id)
    .for("update");
}

/**
 * Under `lockAiEvaluationPage`'s locks: targets still pending, authorized and
 * on their prepared input, the ones whose refresh generation retired, and the
 * ones no live Run authorizes.
 */
export async function guardAiEvaluationPage(
  tx: Database,
  targets: readonly EvaluationPageTarget[],
) {
  const none: EvaluationPageTarget[] = [];
  if (!targets.length) return { valid: none, stale: [], unauthorized: [] };
  const authorization = await aiEvaluationAuthorizations(
    tx,
    targets.map((entry) => entry.evaluation),
    false,
  );
  const rows = new Map(
    (
      await getDb(tx)
        .select()
        .from(aiEvaluation)
        .where(
          inArray(
            aiEvaluation.id,
            targets.map((entry) => entry.evaluation.id),
          ),
        )
    ).map((row) => [row.id, row]),
  );
  const activation = targets.some(
    (entry) => entry.evaluation.executionKind === "ai_refresh",
  )
    ? await readAiRefreshActivation(tx)
    : null;
  const pending = targets.filter((entry) => {
    const row = rows.get(entry.evaluation.id);
    return (
      row &&
      PENDING_AI_STATES.includes(row.state) &&
      row.workKey === entry.evaluation.workKey &&
      row.provenance.inputFingerprint ===
        entry.evaluation.provenance.inputFingerprint
    );
  });
  const current = (entry: EvaluationPageTarget) =>
    entry.evaluation.executionKind !== "ai_refresh" ||
    (activation?.enabled &&
      dependenciesCurrent(entry.evaluation.provenance, activation.manifest));
  return {
    valid: pending.filter(
      (entry) => authorization.has(entry.evaluation.id) && current(entry),
    ),
    stale: pending
      .filter((entry) => activation?.enabled && !current(entry))
      .map((entry) => entry.evaluation.id),
    unauthorized: pending
      .filter((entry) => !authorization.has(entry.evaluation.id))
      .map((entry) => entry.evaluation.id),
  };
}

/** Completed refresh outcomes hold the activation fence at commit, before the Job fence. */
export async function fenceAiEvaluationPage(
  tx: Database,
  targets: readonly EvaluationPageTarget[],
) {
  const refresh = targets
    .filter((entry) => entry.evaluation.executionKind === "ai_refresh")
    .map((entry) => entry.evaluation);
  if (refresh.length)
    await repositoryBeforeCommit(
      tx,
      () => fenceAiEvaluationActivation(tx, refresh),
      { phase: "fence" },
    );
}

/** Retire a set whose generation, manifest or evidence is gone; a domain outcome, never a retry. */
export async function obsoleteAiEvaluations(
  tx: Database,
  ids: readonly string[],
  reason: string,
) {
  if (!ids.length) return;
  await settleAiEvaluations(
    tx,
    ids.map((evaluationId) => ({
      evaluationId,
      state: "obsolete" as const,
      receipt: { reason },
    })),
  );
}

/** An item out of attempts keeps its raw error on the evaluation its requesters read. */
export async function failAiEvaluations(
  tx: Database,
  ids: readonly string[],
  error: string,
) {
  if (!ids.length) return;
  const failed = await getDb(tx)
    .update(aiEvaluation)
    .set({ state: "failed", error, updatedAt: new Date() })
    .where(
      and(
        inArray(aiEvaluation.id, [...ids]),
        inArray(aiEvaluation.state, PENDING_AI_STATES),
      ),
    )
    .returning({ id: aiEvaluation.id });
  // Item locks precede the requester's Job; wake coordinators after commit.
  await runAfterCommit(tx, async (committed) => {
    await (
      await import("~/server/workflows/runs/wake")
    ).wakeAiEvaluationRequesters(
      committed,
      failed.map((row) => row.id),
    );
  });
}

/**
 * Bounded edge progress inside a fenced drain transaction: every source stays
 * pending, authorized and on its prepared input until its final receipt.
 */
export async function continueAiEvaluationPage<T>(
  tx: Database,
  targets: readonly EvaluationPageTarget[],
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  if (!targets.length || targets.length > 25)
    throw new Error("AI continuation requires 1–25 source claims");
  await lockAiEvaluationPage(tx, targets);
  const { valid, stale, unauthorized } = await guardAiEvaluationPage(
    tx,
    targets,
  );
  if (stale.length) throw new Error("AI evaluation generation is obsolete");
  if (unauthorized.length) throw new AiEvaluationUnauthorizedError();
  if (valid.length !== targets.length)
    throw new AiEvaluationAttemptObsoleteError();
  const output = await work(tx);
  await repositoryBeforeCommit(
    tx,
    () =>
      fenceAiEvaluationActivation(
        tx,
        valid.map((entry) => entry.evaluation),
      ),
    { phase: "fence" },
  );
  return output;
}
