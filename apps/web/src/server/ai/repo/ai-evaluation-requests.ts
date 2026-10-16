import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run,
} from "~/server/db/retained-tables";

export const PENDING_AI_STATES: readonly (typeof aiEvaluation.$inferSelect)["state"][] =
  [
    aiEvaluationState.enum.queued,
    aiEvaluationState.enum.running,
    aiEvaluationState.enum.result_ready,
    aiEvaluationState.enum.retry_wait,
  ];

/** A request retains its own demand and receipt; only pending execution is shared. */
export async function enqueueAiEvaluation(
  db: Database,
  input: Omit<typeof aiEvaluation.$inferInsert, "id" | "workKey"> & {
    workKey?: string;
    shareKey: string | null;
  },
  sequence = 0,
) {
  return withTransactionDatabase(db, async (tx) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = crypto.randomUUID();
      const [inserted] = await getDb(tx)
        .insert(aiEvaluation)
        .values({
          ...input,
          id,
          workKey: input.workKey ?? `${input.executionKind}:${id}`,
        })
        .onConflictDoNothing()
        .returning();
      const existing =
        inserted ??
        (input.workKey || input.shareKey
          ? (
              await getDb(tx)
                .select()
                .from(aiEvaluation)
                .where(
                  input.workKey
                    ? eq(aiEvaluation.workKey, input.workKey)
                    : and(
                        eq(aiEvaluation.shareKey, input.shareKey!),
                        inArray(aiEvaluation.state, PENDING_AI_STATES),
                      ),
                )
            )[0]
          : undefined);
      // A completion can release the pending key between the insert and read.
      if (!existing) continue;
      await getDb(tx)
        .insert(aiEvaluationRequest)
        .values({
          runId: input.runId,
          evaluationId: existing.id,
          sequence,
        })
        .onConflictDoNothing();
      return existing;
    }
    throw new Error(
      "AI execution changed repeatedly while registering its request",
    );
  });
}

export async function requestedAiEvaluations(
  db: Database,
  runId: RunId,
  options: { currentOnly?: boolean } = {},
) {
  const rows = await getDb(db)
    .select({ item: aiEvaluation, request: aiEvaluationRequest })
    .from(aiEvaluationRequest)
    .innerJoin(
      aiEvaluation,
      eq(aiEvaluation.id, aiEvaluationRequest.evaluationId),
    )
    .where(eq(aiEvaluationRequest.runId, runId))
    .orderBy(asc(aiEvaluationRequest.sequence), asc(aiEvaluationRequest.id));
  return rows
    .map(({ item, request }) => ({
      ...item,
      receipt:
        request.cancelledAt && !request.receipt
          ? null
          : (request.receipt ?? item.receipt),
      state: request.cancelledAt ? "cancelled" : item.state,
      error: request.cancelledAt ? "Cancelled by a member" : item.error,
    }))
    .filter(
      (item) =>
        !options.currentOnly ||
        !z.object({ retryEvaluationId: z.uuid() }).safeParse(item.receipt)
          .success,
    );
}

export const liveAiRequestRun = (evaluationId: string) => sql`EXISTS (
  SELECT 1 FROM "AiEvaluationRequest" AS request
  WHERE request."evaluationId" = ${evaluationId} AND request."runId" = "Run"."id"
    AND request."cancelledAt" IS NULL
)`;

export async function evaluationIsExecutable(
  db: Database,
  evaluation: { id: string; token: string },
  runId: RunId,
) {
  const [item] = await getDb(db)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.id, evaluation.id),
        eq(aiEvaluation.runId, runId),
        eq(aiEvaluation.attemptToken, evaluation.token),
        inArray(aiEvaluation.state, ["running", "result_ready"]),
        sql`EXISTS (
        SELECT 1 FROM "Run" AS executor WHERE executor.id = ${aiEvaluation.runId} AND executor."deletedAt" IS NULL AND executor."retiredAt" IS NULL
          AND COALESCE((executor.progress->>'attempt')::integer, 0) = ${aiEvaluation.runAttempt}
      )`,
        sql`EXISTS (
        SELECT 1 FROM "AiEvaluationRequest" AS demand JOIN "Run" AS requester ON requester.id = demand."runId"
        WHERE demand."evaluationId" = ${aiEvaluation.id} AND demand."cancelledAt" IS NULL
          AND requester.status = ${runStatus.enum.running} AND requester."deletedAt" IS NULL AND requester."retiredAt" IS NULL
      )`,
      ),
    );
  return Boolean(item);
}

/** Called in the same transaction that stops a requesting Run. */
export async function cancelAiEvaluationRequests(db: Database, runId: RunId) {
  await getDb(db)
    .update(aiEvaluationRequest)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(aiEvaluationRequest.runId, runId),
        isNull(aiEvaluationRequest.receipt),
        sql`EXISTS (SELECT 1 FROM "AiEvaluation" AS item WHERE item.id = ${aiEvaluationRequest.evaluationId} AND item.state IN (${sql.join(
          PENDING_AI_STATES.map((state) => sql`${state}`),
          sql`, `,
        )}))`,
      ),
    );
  const items = await requestedAiEvaluations(db, runId);
  for (const item of items) {
    const [wanted] = await getDb(db)
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          liveAiRequestRun(item.id),
          inArray(run.status, ["running", "paused", "paused_auth"]),
          isNull(run.deletedAt),
        ),
      )
      .limit(1);
    if (!wanted)
      await getDb(db)
        .update(aiEvaluation)
        .set({
          state: "cancelled",
          deadlineAt: null,
          error: "Cancelled by a member",
        })
        .where(
          and(
            eq(aiEvaluation.id, item.id),
            inArray(aiEvaluation.state, PENDING_AI_STATES),
          ),
        );
  }
}

export async function aiExecutionOwner(
  db: Database,
  item: typeof aiEvaluation.$inferSelect,
  preferred?: string,
) {
  if (item.executionKind === "ai_refresh")
    return (
      await getDb(db).select().from(run).where(eq(run.id, item.runId))
    )[0];
  const owners = await getDb(db)
    .select()
    .from(run)
    .where(
      and(
        liveAiRequestRun(item.id),
        eq(run.status, "running"),
        isNull(run.deletedAt),
        isNull(run.retiredAt),
      ),
    )
    .orderBy(asc(run.createdAt), asc(run.id));
  return (
    owners.find((row) => row.id === item.runId) ??
    owners.find((row) => row.id === preferred) ??
    owners[0]
  );
}
