import {
  aiEvaluationState,
  aiRefreshProgress,
  aiProvenance,
  aiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  sql,
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
  withSnapshotWriteDatabase,
  runAfterCommit,
} from "~/server/db/helpers";
import { repositoryBeforeCommit } from "~/server/db/repository-access.boundary";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run,
  job,
} from "~/server/db/schema";
import { JobPausedError, JobDeferredError } from "~/server/generic/jobs/errors";
import { aiEvaluationJobInput } from "~/server/generic/jobs/inputs";
import {
  assertCurrentJob,
  currentJobExecution,
} from "~/server/generic/jobs/repo/execution";
import { jobRunOwned } from "~/server/generic/jobs/repo/external-claim";
import {
  claimJobPage,
  completeJobPage,
  guardJobPage,
  releaseJobPage,
} from "~/server/generic/jobs/repo/queue";

import { readAiRefreshActivation } from "./ai-refresh";
import type {
  EvaluationPageTarget,
  EvaluationPageOutcome,
  EvaluationPagePublication,
} from "./evaluation-page";

/** The universal Job is the only inference/apply owner. Domain rows retain evidence. */
export async function claimAiEvaluation(
  db: Database,
  id: string,
  requestingRunId?: string,
) {
  const execution = currentJobExecution();
  if (
    !execution ||
    execution.claim.kind !== "ai.evaluation" ||
    aiEvaluationJobInput.parse(execution.claim.input).evaluationId !== id
  )
    throw new Error("AI evaluation execution requires its universal Job claim");
  return withTransactionDatabase(db, async (tx) => {
    // Hold Job ownership through the evaluation write and its commit.
    await assertCurrentJob(tx);
    const [existing] = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, id));
    if (!existing || !PENDING_AI_STATES.includes(existing.state)) return null;
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
    if (!owner)
      throw new JobPausedError("No live requester authorizes AI evaluation");
    const [row] = await getDb(tx)
      .update(aiEvaluation)
      .set({
        state: existing.result ? "result_ready" : "running",
        runId: owner.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiEvaluation.id, id),
          inArray(aiEvaluation.state, PENDING_AI_STATES),
        ),
      )
      .returning();
    return row
      ? {
          ...row,
          attemptToken: execution.claim.leaseToken,
          attempts: execution.claim.attempts,
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
  if (
    !execution ||
    execution.claim.leaseToken !== token ||
    aiEvaluationJobInput.parse(execution.claim.input).evaluationId !== id
  )
    throw new Error("AI evaluation attempt is obsolete");
  const [read] = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, id));
  if (!read) throw new Error("AI evaluation attempt is obsolete");
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
        inArray(aiEvaluation.state, ["running", "result_ready"]),
      ),
    )
    .for("update");
  if (!row) throw new Error("AI evaluation attempt is obsolete");
  const owner = owners.find((entry) => entry.id === row.runId);
  if (
    !owner ||
    !owners.some(
      (entry) =>
        entry.status === "running" && !entry.deletedAt && !entry.retiredAt,
    ) ||
    (row.executionKind === "ai_refresh" &&
      (!activation?.enabled ||
        !dependenciesCurrent(
          aiProvenance.parse(row.provenance),
          activation.manifest,
        )))
  )
    throw new Error("AI evaluation generation or Run is obsolete");
  return { row, target: aiEvaluationTarget.parse(row.target) };
}

/** Held only for final writes/commit, never snapshot preparation or requester wakeup. */
async function fenceAiEvaluationActivation(
  tx: Database,
  row: Pick<typeof aiEvaluation.$inferSelect, "executionKind" | "provenance">,
) {
  if (row.executionKind !== "ai_refresh") return;
  const activation = await readAiRefreshActivation(tx, "share");
  if (
    !activation?.enabled ||
    !dependenciesCurrent(
      aiProvenance.parse(row.provenance),
      activation.manifest,
    )
  )
    throw new Error("AI evaluation generation or Run is obsolete");
}

export async function completeAiEvaluation(
  tx: Database,
  id: string,
  token: string,
  receipt: unknown,
  state: "completed" | "blocked" | "obsolete" = "completed",
) {
  await guardAiEvaluation(tx, id, token);
  await settleAiEvaluation(tx, id, z.json().parse(receipt), state);
}

type EvaluationReceipt = z.output<ReturnType<typeof z.json>>;

/** Completion for a transaction that already holds `guardAiEvaluation`'s locks. */
async function settleAiEvaluation(
  tx: Database,
  id: string,
  receipt: EvaluationReceipt,
  state: "completed" | "blocked" | "obsolete",
) {
  const [row] = await getDb(tx)
    .update(aiEvaluation)
    .set({
      state,
      receipt,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(aiEvaluation.id, id))
    .returning({
      executionKind: aiEvaluation.executionKind,
      provenance: aiEvaluation.provenance,
    });
  if (!row) throw new Error("AI evaluation attempt is obsolete");
  await getDb(tx)
    .update(aiEvaluationRequest)
    .set({ receipt })
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, id),
        isNull(aiEvaluationRequest.cancelledAt),
        sql`${aiEvaluationRequest.receipt}->>'retryEvaluationId' IS NULL`,
      ),
    );
  await (
    await import("~/server/workflows/runs/wake")
  ).wakeAiEvaluationRequesters(tx, id);
  await fenceAiEvaluationActivation(tx, row);
}

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
      // The guard above already locked this attempt's Run and row.
      if (settlement === "complete")
        await settleAiEvaluation(tx, id, z.json().parse(result), "completed");
      else await fenceAiEvaluationActivation(tx, row);
      return result;
    },
    { isolationLevel: "serializable" },
  );
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
    running: count("running"),
    retryWait: count("retry_wait"),
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

/** Live authorization shared by claim and publication, including shared demand. */
async function pageAuthorizations(
  db: Database,
  targets: readonly EvaluationPageTarget[],
  lock: "share" | false = "share",
) {
  const ids = targets.map((entry) => entry.evaluation.id);
  const query = getDb(db)
    .select()
    .from(run)
    .where(
      or(
        inArray(
          run.id,
          targets.map((entry) => entry.evaluation.runId),
        ),
        sql`EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."runId"=${run.id} AND r."evaluationId" IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND r."cancelledAt" IS NULL)`,
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
    targets.flatMap((entry) => {
      const item = entry.evaluation;
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

/** Atomic set claim over existing single-slot Job inputs, without per-target claims. */
export async function claimAiEvaluationPage(
  db: Database,
  anchorJobId: string,
  limit = 100,
): Promise<EvaluationPageTarget[]> {
  return withTransactionDatabase(db, async (tx) => {
    const [anchor] = await getDb(tx)
      .select({ item: aiEvaluation, owned: jobRunOwned() })
      .from(job)
      .innerJoin(
        aiEvaluation,
        sql`${job.key} = 'ai-evaluation:' || ${aiEvaluation.id}::text`,
      )
      .where(eq(job.id, parseEntityId("job", anchorJobId)));
    if (!anchor) return [];
    const activation =
      anchor.item.executionKind === "ai_refresh"
        ? await readAiRefreshActivation(tx)
        : null;
    if (anchor.item.executionKind === "ai_refresh" && !activation?.enabled)
      return [];
    const claims = await claimJobPage(tx, {
      limit,
      where:
        and(
          eq(job.kind, "ai.evaluation"),
          sql`${jobRunOwned()} = ${anchor.owned}`,
          sql`${job.key} = 'ai-evaluation:' || (${job.input}->>'evaluationId')`,
          // OFFSET keeps the eligible set hashed instead of comparing every Job
          // with a materialized evaluation catalog in a nested loop.
          sql`${job.key} IN (SELECT 'ai-evaluation:' || e.id::text FROM "AiEvaluation" e
        WHERE e.feature=${anchor.item.feature} AND e."executionKind"=${anchor.item.executionKind}
        AND e.target->>${"kind"}=${anchor.item.target.kind}
        AND e.state IN (${aiEvaluationState.enum.queued},${aiEvaluationState.enum.retry_wait},${aiEvaluationState.enum.running},${aiEvaluationState.enum.result_ready}) OFFSET 0)`,
        ) ?? sql`false`,
    });
    if (!claims.length) return [];
    const byId = new Map(
      claims.map((claim) => [
        aiEvaluationJobInput.parse(claim.input).evaluationId,
        claim,
      ]),
    );
    const rows = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(inArray(aiEvaluation.id, [...byId.keys()]));
    const targets = rows.flatMap((evaluation) => {
      const claim = byId.get(evaluation.id);
      return claim
        ? [
            {
              claim,
              evaluation,
              target: aiEvaluationTarget.parse(evaluation.target),
            },
          ]
        : [];
    });
    // Claim reads authority without a Run lock: coordinator progress must not
    // defer an entire page. Cancellation's item locks are skipped below; final
    // publication locks and rechecks every authorizing Run before effects.
    const authorization = await pageAuthorizations(tx, targets, false);
    const locked = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(
        inArray(
          aiEvaluation.id,
          targets.map((entry) => entry.evaluation.id),
        ),
      )
      .orderBy(aiEvaluation.id)
      .for("update", { skipLocked: true });
    const eligible = locked.filter(
      (item) =>
        authorization.has(item.id) &&
        PENDING_AI_STATES.includes(item.state) &&
        (item.executionKind !== "ai_refresh" ||
          (activation?.enabled &&
            dependenciesCurrent(item.provenance, activation.manifest))),
    );
    const eligibleIds = new Set(eligible.map((item) => item.id));
    const stale = locked.filter(
      (item) =>
        item.executionKind === "ai_refresh" &&
        activation?.enabled &&
        !dependenciesCurrent(item.provenance, activation.manifest),
    );
    const staleIds = new Set(stale.map((item) => item.id));
    if (stale.length) {
      const receipt = { reason: "AI evaluation generation is obsolete" };
      await getDb(tx)
        .update(aiEvaluation)
        .set({ state: "obsolete", receipt, error: null, updatedAt: new Date() })
        .where(inArray(aiEvaluation.id, [...staleIds]));
      await getDb(tx)
        .update(aiEvaluationRequest)
        .set({ receipt })
        .where(
          and(
            inArray(aiEvaluationRequest.evaluationId, [...staleIds]),
            isNull(aiEvaluationRequest.cancelledAt),
            sql`${aiEvaluationRequest.receipt}->>'retryEvaluationId' IS NULL`,
          ),
        );
      await completeJobPage(
        tx,
        stale.map((item) => byId.get(item.id)!),
      );
      // Claim owns Jobs before items; wake coordinator Jobs only after those locks release.
      await runAfterCommit(tx, async (committed) => {
        await (
          await import("~/server/workflows/runs/wake")
        ).wakeAiEvaluationRequesters(committed, [...staleIds]);
      });
    }
    const rejected = targets.filter(
      (entry) =>
        !eligibleIds.has(entry.evaluation.id) &&
        !staleIds.has(entry.evaluation.id),
    );
    await releaseJobPage(
      tx,
      rejected
        .filter((entry) => authorization.has(entry.evaluation.id))
        .map((entry) => entry.claim),
    );
    await releaseJobPage(
      tx,
      rejected
        .filter((entry) => !authorization.has(entry.evaluation.id))
        .map((entry) => entry.claim),
      "paused",
    );
    if (!eligible.length) return [];
    const values = sql.join(
      eligible.map(
        (item) =>
          sql`(${item.id}::uuid, ${authorization.get(item.id)!.id}::uuid)`,
      ),
      sql`, `,
    );
    const claimed = await getDb(tx)
      .update(aiEvaluation)
      .set({
        state: sql`CASE WHEN ${aiEvaluation.result} IS NULL THEN ${aiEvaluationState.enum.running} ELSE ${aiEvaluationState.enum.result_ready} END`,
        runId: sql`page.run_id`,
        updatedAt: new Date(),
      })
      .from(sql`(VALUES ${values}) page(id, run_id)`)
      .where(sql`${aiEvaluation.id}=page.id`)
      .returning(getTableColumns(aiEvaluation));
    return claimed.map((evaluation) => ({
      evaluation,
      claim: byId.get(evaluation.id)!,
      target: aiEvaluationTarget.parse(evaluation.target),
    }));
  });
}

/** Run -> slot -> item -> Job matches scheduling and cancellation; failures take no Run lock. */
export async function guardAiEvaluationPage(
  tx: Database,
  targets: readonly EvaluationPageTarget[],
): Promise<EvaluationPageTarget[]> {
  if (!targets.length) return [];
  if (
    targets.some(
      (entry) =>
        entry.claim.kind !== "ai.evaluation" ||
        entry.claim.key !== `ai-evaluation:${entry.evaluation.id}` ||
        aiEvaluationJobInput.parse(entry.claim.input).evaluationId !==
          entry.evaluation.id,
    )
  )
    throw new Error("AI page target requires its exact universal Job claim");
  const authorization = await pageAuthorizations(tx, targets);
  const keys = [
    ...new Set(targets.map((entry) => entry.evaluation.slotKey)),
  ].sort();
  await getDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest(ARRAY[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]) key ORDER BY key`,
  );
  const rows = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(
      inArray(
        aiEvaluation.id,
        targets.map((entry) => entry.evaluation.id),
      ),
    )
    .orderBy(aiEvaluation.id)
    .for("update");
  const claims = await guardJobPage(
    tx,
    targets.map((entry) => entry.claim),
  );
  const tokens = new Set(claims.map((claim) => claim.id));
  const activation = targets.some(
    (entry) => entry.evaluation.executionKind === "ai_refresh",
  )
    ? await readAiRefreshActivation(tx)
    : null;
  const valid = new Set(
    rows
      .filter(
        (item) =>
          authorization.has(item.id) &&
          ["running", "result_ready"].includes(item.state) &&
          (item.executionKind !== "ai_refresh" ||
            (activation?.enabled &&
              dependenciesCurrent(item.provenance, activation.manifest))),
      )
      .map((item) => item.id),
  );
  return targets.filter(
    (entry) =>
      valid.has(entry.evaluation.id) &&
      tokens.has(entry.claim.id) &&
      rows.some(
        (row) =>
          row.id === entry.evaluation.id &&
          row.provenance.inputFingerprint ===
            entry.evaluation.provenance.inputFingerprint &&
          row.workKey === entry.evaluation.workKey,
      ),
  );
}

/** One bounded serializable business/receipt/Job commit, with target-local validity. */
export async function publishAiEvaluationPage<O>(
  db: Database,
  outcomes: readonly EvaluationPageOutcome<O>[],
  publish: (
    tx: Database,
    valid: readonly EvaluationPageOutcome<O>[],
  ) => Promise<EvaluationPagePublication[]>,
): Promise<EvaluationPagePublication[]> {
  if (currentJobExecution())
    throw new Error(
      "AI page publication requires an explicit claim set without a target context",
    );
  if (outcomes.length > 25)
    throw new Error("AI publication chunks contain at most 25 targets");
  if (!outcomes.length) return [];
  return withSnapshotWriteDatabase(
    db,
    async (tx) => {
      const valid = await guardAiEvaluationPage(
        tx,
        outcomes.map((entry) => entry.target),
      );
      const ids = new Set(valid.map((entry) => entry.evaluation.id));
      const authorized = outcomes.filter((entry) =>
        ids.has(entry.target.evaluation.id),
      );
      if (!authorized.length) return [];
      const publications = await publish(tx, authorized);
      if (
        publications.length !== authorized.length ||
        new Set(publications.map((entry) => entry.evaluationId)).size !==
          publications.length ||
        publications.some((entry) => !ids.has(entry.evaluationId))
      )
        throw new Error(
          "AI page adapter returned an unexpected publication set",
        );
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
      // The activation fence is registered after business hooks and before Job settlement.
      await repositoryBeforeCommit(
        tx,
        async () => {
          const refresh = valid.filter(
            (entry) => entry.evaluation.executionKind === "ai_refresh",
          );
          if (!refresh.length) return;
          const activation = await readAiRefreshActivation(tx, "share");
          if (
            !activation?.enabled ||
            refresh.some(
              (entry) =>
                !dependenciesCurrent(
                  entry.evaluation.provenance,
                  activation.manifest,
                ),
            )
          )
            throw new Error("AI evaluation generation or Run is obsolete");
        },
        { phase: "fence" },
      );
      await completeJobPage(
        tx,
        valid.map((entry) => entry.claim),
      );
      return publications;
    },
    { isolationLevel: "serializable" },
  );
}

export type EvaluationPageFailure = {
  target: EvaluationPageTarget;
  state: "obsolete" | "failed" | "retry_wait";
  error: string;
  wait?: { until: Date; reason: import("@cubby/schemas/job").JobWaitReason };
};

/** Diagnostic settlement also serializes with slot admission and queued successors. */
export async function failAiEvaluationPage(
  db: Database,
  failures: readonly EvaluationPageFailure[],
) {
  if (!failures.length) return;
  await withTransactionDatabase(db, async (tx) => {
    const keys = [
      ...new Set(failures.map((entry) => entry.target.evaluation.slotKey)),
    ].sort();
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest(ARRAY[${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[]) key ORDER BY key`,
    );
    const rows = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(
        inArray(
          aiEvaluation.id,
          failures.map((entry) => entry.target.evaluation.id),
        ),
      )
      .orderBy(aiEvaluation.id)
      .for("update");
    const claims = await guardJobPage(
      tx,
      failures.map((entry) => entry.target.claim),
    );
    const tokens = new Set(claims.map((claim) => claim.id));
    const pending = new Set(
      rows
        .filter((row) => ["running", "result_ready"].includes(row.state))
        .map((row) => row.id),
    );
    const valid = failures.filter(
      (entry) =>
        pending.has(entry.target.evaluation.id) &&
        tokens.has(entry.target.claim.id),
    );
    if (!valid.length) return;
    const values = sql.join(
      valid.map((entry) => {
        const claim = entry.target.claim;
        return sql`(${entry.target.evaluation.id}::uuid, ${claim.id}::uuid, ${entry.state}::text, ${entry.error}::text, ${entry.wait?.until.toISOString() ?? new Date(Date.now() + Math.min(60_000, 1000 * 2 ** claim.attempts)).toISOString()}::timestamp, ${entry.wait?.reason ?? null}::text, ${Boolean(entry.wait)}::boolean)`;
      }),
      sql`, `,
    );
    await getDb(tx)
      .update(aiEvaluation)
      .set({
        state: sql`CASE WHEN page.state=${aiEvaluationState.enum.retry_wait} AND EXISTS (SELECT 1 FROM "AiEvaluation" successor WHERE successor."slotKey"=${aiEvaluation.slotKey} AND successor.id<>${aiEvaluation.id} AND successor.state IN (${aiEvaluationState.enum.queued},${aiEvaluationState.enum.retry_wait})) THEN ${aiEvaluationState.enum.obsolete} ELSE page.state END`,
        error: sql`page.error`,
        updatedAt: new Date(),
      })
      .from(
        sql`(VALUES ${values}) page(id, job_id, state, error, available, reason, waiting)`,
      )
      .where(sql`${aiEvaluation.id}=page.id`);
    await repositoryBeforeCommit(
      tx,
      async (commit) => {
        const current = await guardJobPage(
          commit,
          valid.map((entry) => entry.target.claim),
        );
        if (current.length !== valid.length)
          throw new Error("AI evaluation attempt is obsolete");
        await commit
          .update(job)
          .set({
            state: sql`CASE WHEN e.state=${aiEvaluationState.enum.obsolete} THEN ${aiEvaluationState.enum.completed} WHEN e.state=${aiEvaluationState.enum.failed} THEN ${aiEvaluationState.enum.failed} WHEN page.waiting THEN ${aiEvaluationState.enum.queued} ELSE ${aiEvaluationState.enum.retry_wait} END`,
            attempts: sql`CASE WHEN page.waiting THEN greatest(0, ${job.attempts}-1) ELSE ${job.attempts} END`,
            error: sql`page.error`,
            availableAt: sql`page.available`,
            waitReason: sql`page.reason`,
            waitUntil: sql`CASE WHEN page.waiting THEN page.available ELSE NULL END`,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .from(
            sql`(VALUES ${values}) page(id, job_id, state, error, available, reason, waiting) JOIN "AiEvaluation" e ON e.id=page.id`,
          )
          .where(sql`${job.id}=page.job_id`);
      },
      { phase: "publication" },
    );
    // Failure takes no Run lock; release item/Job locks before touching coordinators.
    await runAfterCommit(tx, async (committed) => {
      await (
        await import("~/server/workflows/runs/wake")
      ).wakeAiEvaluationRequesters(
        committed,
        valid.map((entry) => entry.target.evaluation.id),
      );
    });
  });
}

/** Bounded edge progress leaves each source's evaluation/Job running until its final receipt. */
export async function publishAiEvaluationContinuation<T>(
  db: Database,
  targets: readonly EvaluationPageTarget[],
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  if (!targets.length || targets.length > 25)
    throw new Error("AI continuation requires 1–25 source claims");
  const context = currentJobExecution();
  if (
    context &&
    (targets.length !== 1 || targets[0]!.claim.id !== context.claim.id)
  )
    throw new Error(
      "AI continuation cannot borrow a sibling's execution context",
    );
  return withSnapshotWriteDatabase(
    db,
    async (tx) => {
      const valid = await guardAiEvaluationPage(tx, targets);
      if (valid.length !== targets.length)
        throw new Error("AI evaluation generation or Run is obsolete");
      const output = await work(tx);
      await repositoryBeforeCommit(
        tx,
        async () => {
          const activation = await readAiRefreshActivation(tx, "share");
          if (
            valid.some(
              (entry) =>
                entry.evaluation.executionKind === "ai_refresh" &&
                (!activation?.enabled ||
                  !dependenciesCurrent(
                    entry.evaluation.provenance,
                    activation.manifest,
                  )),
            )
          )
            throw new Error("AI evaluation generation or Run is obsolete");
        },
        { phase: "fence" },
      );
      await repositoryBeforeCommit(
        tx,
        async (commit) => {
          if (
            (
              await guardJobPage(
                commit,
                targets.map((entry) => entry.claim),
              )
            ).length !== targets.length
          )
            throw new Error("AI evaluation attempt is obsolete");
        },
        { phase: "publication" },
      );
      return output;
    },
    { isolationLevel: "serializable" },
  );
}
