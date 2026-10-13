import {
  aiRefreshProgress,
  aiProvenance,
  aiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { dependenciesCurrent } from "~/server/ai/refresh-policy";
import type { Database } from "~/server/db";
import { aiEvaluation, run } from "~/server/db/schema";

import { readAiRefreshActivation } from "./ai-refresh";
import { getDb, withTransactionDatabase } from "./database-helpers";

export async function claimAiEvaluation(db: Database, id: string) {
  return withTransactionDatabase(db, async (tx) => {
    const now = new Date();
    await readAiRefreshActivation(tx, "update");
    const [existing] = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, id));
    if (!existing) return null;
    const [owner] = await getDb(tx)
      .select()
      .from(run)
      .where(eq(run.id, existing.runId));
    if (owner?.status !== "running" || owner.deletedAt || owner.retiredAt)
      return null;
    const [active] = await getDb(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(aiEvaluation)
      .where(
        and(
          inArray(aiEvaluation.state, ["running", "result_ready"]),
          sql`${aiEvaluation.deadlineAt} > ${now}`,
        ),
      );
    if (existing.state !== "result_ready" && (active?.count ?? 0) >= 2)
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
        existing.runAttempt === progress.attempt
      )
        return null;
      const [ready] = await getDb(tx)
        .update(aiEvaluation)
        .set({
          attemptToken: token,
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
  const activation = await readAiRefreshActivation(tx, "share");
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
  const [owner] = await getDb(tx)
    .select()
    .from(run)
    .where(eq(run.id, row.runId))
    .for("no key update");
  const progress = z
    .object({ attempt: z.number().default(0) })
    .passthrough()
    .parse(owner?.progress ?? {});
  if (
    owner?.status !== "running" ||
    owner.deletedAt ||
    owner.retiredAt ||
    row.runAttempt !== progress.attempt ||
    !activation?.enabled ||
    !dependenciesCurrent(
      aiProvenance.parse(row.provenance),
      activation.manifest,
    )
  )
    throw new Error("AI evaluation generation or Run is obsolete");
  return { row, target: aiEvaluationTarget.parse(row.target) };
}

export async function completeAiEvaluation(
  tx: Database,
  id: string,
  token: string,
  receipt: unknown,
  state: "completed" | "blocked" = "completed",
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
