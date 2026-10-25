import { aiEvaluationState, aiProvenance } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { jobState } from "@cubby/schemas/job";
import { runStatus } from "@cubby/schemas/run-fields";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";

/** Matches AiEvaluation's generated SQL key, including UTF-8 length prefixes. */
export const evaluationSlotKey = ({
  feature,
  target,
}: Pick<typeof aiEvaluation.$inferSelect, "feature" | "target">) =>
  [
    feature,
    target.entity,
    target.recordId,
    target.field ?? "",
    target.kind === "product_pair" ? target.otherId : "",
  ]
    .map((value) => `${new TextEncoder().encode(value).length}:${value}`)
    .join("");

/** Deterministic attempt suffixes keep historical work keys unique without chains. */
export async function availableEvaluationWorkKey(
  db: Database,
  {
    baseKey,
    slotKey,
    updatingId,
  }: { baseKey: string; slotKey: string; updatingId?: string },
): Promise<string> {
  const rows = await getDb(db)
    .select({ id: aiEvaluation.id, workKey: aiEvaluation.workKey })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.slotKey, slotKey),
        or(
          eq(aiEvaluation.workKey, baseKey),
          sql`starts_with(${aiEvaluation.workKey}, ${`${baseKey}:attempt:`})`,
        ),
      ),
    );
  const held = new Set(
    rows.filter((row) => row.id !== updatingId).map((row) => row.workKey),
  );
  let key = baseKey;
  for (let attempt = 1; held.has(key); attempt++)
    key = `${baseKey}:attempt:${attempt}`;
  return key;
}

export const PENDING_AI_STATES: readonly (typeof aiEvaluation.$inferSelect)["state"][] =
  [
    aiEvaluationState.enum.queued,
    aiEvaluationState.enum.running,
    aiEvaluationState.enum.result_ready,
    aiEvaluationState.enum.retry_wait,
  ];

const inputIdentity = (
  provenance: (typeof aiEvaluation.$inferSelect)["provenance"],
) => JSON.stringify(aiProvenance.omit({ model: true }).parse(provenance));

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
    const slotKey = evaluationSlotKey(input);
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${slotKey}, 0))`,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = crypto.randomUUID();
      const [latest] = await getDb(tx)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.slotKey, slotKey))
        .orderBy(desc(aiEvaluation.createdAt), desc(aiEvaluation.id))
        .limit(1);
      const baseKey = input.workKey ?? `${input.executionKind}:${id}`;
      const reusable =
        latest &&
        inputIdentity(latest.provenance) === inputIdentity(input.provenance) &&
        ["completed", "running", "result_ready"].includes(latest.state)
          ? latest
          : undefined;
      const workKey = await availableEvaluationWorkKey(tx, {
        baseKey,
        slotKey,
      });
      const [inserted] = reusable
        ? []
        : await getDb(tx)
            .insert(aiEvaluation)
            .values({ ...input, id, workKey })
            .onConflictDoNothing()
            .returning();
      const existing =
        inserted ??
        reusable ??
        (
          await getDb(tx)
            .select()
            .from(aiEvaluation)
            .where(
              or(
                and(
                  eq(aiEvaluation.slotKey, slotKey),
                  inArray(aiEvaluation.state, ["queued", "retry_wait"]),
                ),
                input.workKey ? eq(aiEvaluation.workKey, workKey) : undefined,
                input.shareKey
                  ? and(
                      eq(aiEvaluation.shareKey, input.shareKey),
                      inArray(aiEvaluation.state, PENDING_AI_STATES),
                    )
                  : undefined,
              ),
            )
            .orderBy(
              sql`CASE WHEN ${aiEvaluation.state} IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.retry_wait}) THEN 0 ELSE 1 END`,
            )
            .limit(1)
        )[0];
      // A completion can release the pending key between the insert and read.
      if (!existing) continue;
      if (
        !inserted &&
        (existing.state === "queued" || existing.state === "retry_wait") &&
        inputIdentity(existing.provenance) !== inputIdentity(input.provenance)
      ) {
        const updated = await getDb(tx)
          .update(aiEvaluation)
          .set({
            target: input.target,
            provenance: input.provenance,
            snapshot: input.snapshot,
            result: null,
            receipt: null,
            error: null,
            shareKey: input.shareKey,
            workKey: await availableEvaluationWorkKey(tx, {
              baseKey,
              slotKey,
              updatingId: existing.id,
            }),
          })
          .where(
            and(
              eq(aiEvaluation.id, existing.id),
              inArray(aiEvaluation.state, ["queued", "retry_wait"]),
            ),
          )
          .returning();
        if (!updated[0]) continue;
        Object.assign(existing, updated[0]);
      }
      await getDb(tx)
        .insert(aiEvaluationRequest)
        .values({
          runId: input.runId,
          evaluationId: existing.id,
          sequence,
        })
        .onConflictDoNothing();
      if (inserted)
        await enqueueJob(tx, {
          key: `ai-evaluation:${existing.id}`,
          kind: "ai.evaluation",
          input: { evaluationId: existing.id },
          priority: existing.executionKind === "ai_refresh" ? 0 : 10,
        });
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
        sql`EXISTS (SELECT 1 FROM "Job" j WHERE j.key=${`ai-evaluation:${evaluation.id}`} AND j.state=${jobState.enum.running} AND j."leaseToken"=${evaluation.token}::uuid AND j."leaseExpiresAt">now())`,
        inArray(aiEvaluation.state, ["running", "result_ready"]),
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
  // Admission is held by the caller. Cancel the entire abandoned set with one
  // predicate rather than keeping that global lock for two queries per item.
  await getDb(db)
    .update(aiEvaluation)
    .set({
      state: "cancelled",
      error: "Cancelled by a member",
    })
    .where(
      and(
        inArray(aiEvaluation.state, PENDING_AI_STATES),
        sql`EXISTS (SELECT 1 FROM "AiEvaluationRequest" own WHERE own."evaluationId" = ${aiEvaluation.id} AND own."runId" = ${runId})`,
        sql`NOT EXISTS (
      SELECT 1 FROM "AiEvaluationRequest" demand JOIN "Run" requester ON requester.id = demand."runId"
      WHERE demand."evaluationId" = ${aiEvaluation.id} AND demand."cancelledAt" IS NULL
        AND requester.status IN (${runStatus.enum.running}, ${runStatus.enum.paused}, ${runStatus.enum.paused_auth}) AND requester."deletedAt" IS NULL
    )`,
      ),
    );
  const [wanted] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.status, "running"),
        isNull(run.deletedAt),
        isNull(run.retiredAt),
        sql`EXISTS (
      SELECT 1 FROM "AiEvaluationRequest" own JOIN "AiEvaluationRequest" demand ON demand."evaluationId" = own."evaluationId"
      WHERE own."runId" = ${runId} AND demand."runId" = ${run.id} AND demand."cancelledAt" IS NULL
    )`,
      ),
    )
    .limit(1);
  return Boolean(wanted);
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
