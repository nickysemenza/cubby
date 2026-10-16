import {
  aiRefreshProgress,
  aiProvenance,
  aiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { dependenciesCurrent } from "~/server/ai/policy/refresh-manifest";
import {
  aiExecutionOwner,
  liveAiRequestRun,
} from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest, run } from "~/server/db/schema";

import { readAiRefreshActivation } from "./ai-refresh";

export async function claimAiEvaluation(
  db: Database,
  id: string,
  requestingRunId?: string,
) {
  return withTransactionDatabase(db, async (tx) => {
    const now = new Date();
    // Busy claims defer to the existing Workflow retry without consuming an
    // origin connection waiting behind admission. Activation remains policy,
    // not a prerequisite for member-requested execution.
    const admission = z
      .object({ rows: z.tuple([z.object({ admitted: z.boolean() })]) })
      .parse(
        await getDb(tx).execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext('cubby-ai-admission')) AS admitted`,
        ),
      );
    if (!admission.rows[0].admitted) return null;
    const [existing] = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, id));
    if (!existing) return null;
    if (existing.executionKind === "ai_refresh") {
      const activation = await readAiRefreshActivation(tx, "update");
      if (!activation?.enabled) return null;
    }
    const owner = await aiExecutionOwner(tx, existing, requestingRunId);
    if (owner?.status !== "running" || owner.deletedAt || owner.retiredAt)
      return null;
    if (requestingRunId && owner.id !== requestingRunId) return null;
    const [active] = await getDb(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(aiEvaluation)
      .where(
        and(
          inArray(aiEvaluation.state, ["running", "result_ready"]),
          sql`${aiEvaluation.deadlineAt} > ${now}`,
          existing.executionKind === "ai_refresh"
            ? eq(aiEvaluation.executionKind, "ai_refresh")
            : inArray(aiEvaluation.executionKind, [
                "mail_reclassify",
                "suggestion_sweep",
              ]),
        ),
      );
    const [memberDue] =
      existing.executionKind === "ai_refresh"
        ? await getDb(tx)
            .select({ id: aiEvaluation.id })
            .from(aiEvaluation)
            .innerJoin(run, eq(run.id, aiEvaluation.runId))
            .where(
              and(
                inArray(aiEvaluation.executionKind, [
                  "mail_reclassify",
                  "suggestion_sweep",
                ]),
                eq(run.status, "running"),
                or(
                  eq(aiEvaluation.state, "queued"),
                  and(
                    eq(aiEvaluation.state, "retry_wait"),
                    lt(aiEvaluation.nextAttemptAt, now),
                  ),
                ),
              ),
            )
            .limit(1)
        : [];
    // Reserve priority for member work while retaining one automatic slot.
    const limit = memberDue ? 1 : 2;
    if (existing.state !== "result_ready" && (active?.count ?? 0) >= limit)
      return null;
    if (
      existing.attempts >= 3 &&
      existing.deadlineAt &&
      existing.deadlineAt <= now &&
      existing.state === "running"
    ) {
      await getDb(tx)
        .update(aiEvaluation)
        .set({
          state: "failed",
          error: "AI evaluation exhausted interrupted inference attempts",
        })
        .where(eq(aiEvaluation.id, id));
      return null;
    }
    const token = crypto.randomUUID();
    const progress = z
      .object({ attempt: z.number().default(0) })
      .passthrough()
      .parse(owner.progress ?? {});
    if (existing.state === "result_ready") {
      if (
        existing.deadlineAt &&
        existing.deadlineAt > now &&
        existing.runAttempt === progress.attempt &&
        existing.runId === owner.id
      )
        return null;
      const [ready] = await getDb(tx)
        .update(aiEvaluation)
        .set({
          attemptToken: token,
          runId: owner.id,
          runAttempt: progress.attempt,
          deadlineAt: new Date(now.getTime() + 10 * 60_000),
          updatedAt: now,
        })
        .where(eq(aiEvaluation.id, id))
        .returning();
      return ready ?? null;
    }
    const [row] = await getDb(tx)
      .update(aiEvaluation)
      .set({
        state: "running",
        runId: owner.id,
        runAttempt: progress.attempt,
        attemptToken: token,
        attempts: sql`${aiEvaluation.attempts} + 1`,
        deadlineAt: new Date(now.getTime() + 10 * 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(aiEvaluation.id, id),
          lt(aiEvaluation.attempts, 3),
          or(
            eq(aiEvaluation.state, "queued"),
            and(
              eq(aiEvaluation.state, "retry_wait"),
              lt(aiEvaluation.nextAttemptAt, now),
            ),
            and(
              eq(aiEvaluation.state, "running"),
              lt(aiEvaluation.deadlineAt, now),
            ),
          ),
        ),
      )
      .returning();
    if (row) return row;
    return null;
  });
}

/** The active manifest and Run state are read in the business-write transaction. */
export async function guardAiEvaluation(
  tx: Database,
  id: string,
  token: string,
) {
  const [read] = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, id));
  if (!read) throw new Error("AI evaluation attempt is obsolete");
  const activation =
    read.executionKind === "ai_refresh"
      ? await readAiRefreshActivation(tx, "share")
      : null;
  // Match cancellation's Run-before-item lock order. A shared item's original
  // requester may stop while another live requester still wants publication.
  const owners = await getDb(tx)
    .select()
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
        eq(aiEvaluation.attemptToken, token),
        inArray(aiEvaluation.state, ["running", "result_ready"]),
      ),
    )
    .for("update");
  if (!row) throw new Error("AI evaluation attempt is obsolete");
  const owner = owners.find((entry) => entry.id === row.runId);
  const progress = z
    .object({ attempt: z.number().default(0) })
    .passthrough()
    .parse(owner?.progress ?? {});
  if (
    !owner ||
    !owners.some(
      (entry) =>
        entry.status === "running" && !entry.deletedAt && !entry.retiredAt,
    ) ||
    row.runAttempt !== progress.attempt ||
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

export async function completeAiEvaluation(
  tx: Database,
  id: string,
  token: string,
  receipt: unknown,
  state: "completed" | "blocked" | "obsolete" = "completed",
) {
  await getDb(tx)
    .update(aiEvaluation)
    .set({
      state,
      receipt: z.json().parse(receipt),
      error: null,
      deadlineAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(aiEvaluation.id, id), eq(aiEvaluation.attemptToken, token)));
  await getDb(tx)
    .update(aiEvaluationRequest)
    .set({ receipt: z.json().parse(receipt) })
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
}

export async function publishAiEvaluation<T>(
  db: Database,
  id: string,
  token: string,
  work: (tx: Database) => Promise<T>,
) {
  return withTransactionDatabase(
    db,
    async (tx) => {
      await guardAiEvaluation(tx, id, token);
      const result = await work(tx);
      await completeAiEvaluation(tx, id, token, result);
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
