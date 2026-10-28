import {
  aiEvaluationState,
  aiExecutionKind,
  aiProvenance,
} from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run,
} from "~/server/db/retained-tables";

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

/** Evaluations with outstanding work; retry and lease state live on the drain item. */
export const PENDING_AI_STATES: readonly (typeof aiEvaluation.$inferSelect)["state"][] =
  [aiEvaluationState.enum.queued, aiEvaluationState.enum.result_ready];

const inputIdentity = (
  provenance: (typeof aiEvaluation.$inferSelect)["provenance"],
) => JSON.stringify(aiProvenance.omit({ model: true }).parse(provenance));

type EvaluationEnrollment = Omit<
  typeof aiEvaluation.$inferInsert,
  "id" | "workKey"
> & { workKey?: string; shareKey: string | null };

/** A request retains its own demand and receipt; only pending execution is shared. */
export async function enqueueAiEvaluation(
  db: Database,
  input: EvaluationEnrollment,
  sequence = 0,
) {
  const [row] = await enqueueAiEvaluations(db, [{ input, sequence }]);
  if (!row) throw new Error("AI evaluation enrollment returned no slot");
  return row;
}

/** Stable slot locks, one history read, and set enrollment for a finite producer page. */
export async function enqueueAiEvaluations(
  db: Database,
  inputs: readonly { input: EvaluationEnrollment; sequence?: number }[],
) {
  if (!inputs.length) return [];
  const unique = new Map(
    inputs.map(({ input }) => [evaluationSlotKey(input), input]),
  );
  const keys = [...unique.keys()].sort();
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest(ARRAY[${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[]) key ORDER BY key`,
    );
    const history = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(inArray(aiEvaluation.slotKey, keys))
      .orderBy(aiEvaluation.id)
      .for("update");
    history.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );
    const result = new Map<string, typeof aiEvaluation.$inferSelect>();
    const updates: {
      row: typeof aiEvaluation.$inferSelect;
      input: EvaluationEnrollment;
      workKey: string;
    }[] = [];
    const fresh: (typeof aiEvaluation.$inferInsert)[] = [];
    for (const [key, input] of unique) {
      const rows = history.filter((row) => row.slotKey === key);
      const latest = rows[0];
      // Unchanged input joins in-flight work. Automatic refresh also reuses
      // a completed result, so unchanged targets are never re-checked; a
      // member's request owns a fresh evaluation, which the response cache
      // answers without another paid call.
      const reusable =
        latest &&
        inputIdentity(latest.provenance) === inputIdentity(input.provenance) &&
        (latest.state === "result_ready" ||
          (latest.state === "completed" &&
            input.executionKind === aiExecutionKind.enum.ai_refresh))
          ? latest
          : undefined;
      const open = rows.find((row) => row.state === "queued");
      const existing = reusable ?? open;
      const id = existing?.id ?? crypto.randomUUID();
      const base = input.workKey ?? `${input.executionKind}:${id}`;
      const held = new Set(
        rows.filter((row) => row.id !== existing?.id).map((row) => row.workKey),
      );
      let workKey = base;
      for (let attempt = 1; held.has(workKey); attempt++)
        workKey = `${base}:attempt:${attempt}`;
      if (!existing) fresh.push({ ...input, id, workKey });
      else {
        result.set(key, existing);
        if (
          existing.state === "queued" &&
          inputIdentity(existing.provenance) !== inputIdentity(input.provenance)
        )
          updates.push({ row: existing, input, workKey });
      }
    }
    if (updates.length) {
      const values = sql.join(
        updates.map(
          ({ row, input, workKey }) =>
            sql`(${row.id}::uuid, ${JSON.stringify(input.target)}::jsonb, ${JSON.stringify(input.provenance)}::jsonb, ${JSON.stringify(input.snapshot)}::jsonb, ${input.shareKey}::text, ${workKey}::text)`,
        ),
        sql`, `,
      );
      const changed = await getDb(tx)
        .update(aiEvaluation)
        .set({
          target: sql`page.target`,
          provenance: sql`page.provenance`,
          snapshot: sql`page.snapshot`,
          shareKey: sql`page.share_key`,
          workKey: sql`page.work_key`,
          result: null,
          receipt: null,
          error: null,
          updatedAt: new Date(),
        })
        .from(
          sql`(VALUES ${values}) page(id, target, provenance, snapshot, share_key, work_key)`,
        )
        .where(sql`${aiEvaluation.id}=page.id`)
        .returning(getTableColumns(aiEvaluation));
      for (const row of changed) result.set(row.slotKey, row);
    }
    const created = fresh.length
      ? await getDb(tx).insert(aiEvaluation).values(fresh).returning()
      : [];
    for (const row of created) result.set(row.slotKey, row);
    await getDb(tx)
      .insert(aiEvaluationRequest)
      .values(
        inputs.map(({ input, sequence }, index) => ({
          runId: input.runId,
          evaluationId: result.get(evaluationSlotKey(input))!.id,
          sequence: sequence ?? index,
        })),
      )
      .onConflictDoNothing();
    // New or re-input work takes a fresh ticket; joining demand re-marks only
    // a parked item or a more urgent one.
    const { markAiEvaluationWork } = await import("./ai-evaluation-work");
    const marked = new Set([
      ...created.map((row) => row.id),
      ...updates.map(({ row }) => row.id),
    ]);
    await markAiEvaluationWork(tx, [...marked]);
    await markAiEvaluationWork(
      tx,
      [...result.values()].map((row) => row.id).filter((id) => !marked.has(id)),
      { revive: true },
    );
    return inputs.map(({ input }) => result.get(evaluationSlotKey(input))!);
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
  const { aiEvaluationAttemptLive } = await import("./ai-evaluation-work");
  const [item] = await getDb(db)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.id, evaluation.id),
        eq(aiEvaluation.runId, runId),
        aiEvaluationAttemptLive(aiEvaluation.id, evaluation.token),
        inArray(aiEvaluation.state, PENDING_AI_STATES),
        sql`EXISTS (
        SELECT 1 FROM "AiEvaluationRequest" AS demand JOIN "Run" AS requester ON requester.id = demand."runId"
        WHERE demand."evaluationId" = ${aiEvaluation.id} AND demand."cancelledAt" IS NULL
          AND requester.status = ${runStatus.enum.running} AND ${notDeleted("requester")} AND requester."retiredAt" IS NULL
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
        AND requester.status IN (${runStatus.enum.running}, ${runStatus.enum.paused}, ${runStatus.enum.paused_auth}) AND ${notDeleted("requester")}
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
