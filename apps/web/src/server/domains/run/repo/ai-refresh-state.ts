import {
  aiEvaluationState,
  aiRefreshActivation,
  aiRefreshRunInput,
  suggestionSupersessionReceipt,
  type AiEvaluationTarget,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import {
  parseEntityId,
  runEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import { MAX_AUTOMATIC_WORKFLOW_FAILURES } from "@cubby/schemas/workflow-runs";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  aiEvaluation,
  product,
  email,
  emailClassificationObservation,
  ledgerParty,
  run,
  assessmentState as suggestion,
} from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";

import {
  hasAiRefreshRunCapacity,
  tryLockAiRefreshScheduling,
} from "./ai-refresh-admission";
import { ensureRun } from "./ensure-run";

export type AssessmentStateRow = typeof suggestion.$inferSelect;
export type FieldRefreshCursor = Pick<
  AssessmentStateRow,
  "entity" | "recordId" | "field"
>;

const jsonSnapshot = (value: unknown) =>
  z.json().parse(JSON.parse(JSON.stringify(value)));

type EvaluationTargetInput = {
  target: AiEvaluationTarget;
  provenance: AiProvenance;
  snapshot: unknown;
  blockedReason?: string;
};

const targetWorkKey = ({ target, provenance }: EvaluationTargetInput) =>
  sha256Hex(
    JSON.stringify({
      entity: target.entity,
      recordId: target.recordId,
      field: target.field,
      provenance: { ...provenance, model: null },
    }),
  );

// Work that settled without publishing (a declined publication, Mail import
// off, a fenced attempt) reopens when discovery finds it again: a replacement
// row `<workKey>:reopen:<n>` carries the work, and the settled row keeps its
// Run, receipt and error, linked by `retryEvaluationId` (the operator-retry
// shape). The bound stops a persistently declined source from re-spending
// every pass; failed and cancelled work stays with the operator's retry.
const MAX_REOPENS = 3;
const REOPEN_SEPARATOR = ":reopen:";
const retryReceipt = z.object({ retryEvaluationId: z.uuid() });
const refreshRunRevision = sql<number>`coalesce((${run.input}->${aiRefreshRunInput.keyof().enum.activation}->>${aiRefreshActivation.keyof().enum.revision})::int, 0)`;

/** The row a work key's retries and reopens currently end at, with its reopen count. */
async function workKeyTip(
  db: Database,
  workKey: string,
  base: typeof aiEvaluation.$inferSelect | undefined,
) {
  let tip = base;
  let reopens = 0;
  for (let hop = 0; tip && hop <= MAX_REOPENS * 4; hop++) {
    const next = retryReceipt.safeParse(tip.receipt).data?.retryEvaluationId;
    if (!next) break;
    const [row] = await getDb(db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, next));
    if (!row) break;
    tip = row;
    // An operator retry of a reopen (`<workKey>:reopen:<n>:operator-retry:<k>`)
    // also counts toward the cap.
    if (row.workKey.startsWith(`${workKey}${REOPEN_SEPARATOR}`)) reopens++;
  }
  const [owner] =
    tip && ["blocked", "obsolete"].includes(tip.state)
      ? await getDb(db)
          .select({ failureCode: run.failureCode })
          .from(run)
          .where(eq(run.id, tip.runId))
      : [];
  return {
    tip,
    reopens,
    reopenable:
      tip !== undefined &&
      ["blocked", "obsolete"].includes(tip.state) &&
      owner?.failureCode !== "user_cancelled" &&
      reopens < MAX_REOPENS,
  };
}

/** Whether any target would insert a new row or reopen a settled one. */
async function hasAdmissibleTarget(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  const keys = await Promise.all(targets.map(targetWorkKey));
  const bases = keys.length
    ? await getDb(db)
        .select()
        .from(aiEvaluation)
        .where(inArray(aiEvaluation.workKey, keys))
    : [];
  for (const [index, item] of targets.entries()) {
    const base = bases.find((row) => row.workKey === keys[index]);
    if (!base) return true;
    if (item.blockedReason) continue;
    const chain = await workKeyTip(db, keys[index]!, base);
    if (chain.reopenable) return true;
  }
  return false;
}

async function insertTarget(
  db: Database,
  runId: string,
  item: EvaluationTargetInput,
) {
  const { target, provenance, blockedReason } = item;
  const workKey = await targetWorkKey(item);
  const insert = (key: string, client: Database) =>
    getDb(client)
      .insert(aiEvaluation)
      .values({
        runId: runEntityId.parse(runId),
        feature:
          target.kind === "connection"
            ? "entity-connections"
            : target.kind === "field"
              ? "field-suggestion"
              : target.kind === "product"
                ? "product-identity"
                : "mailbox-triage",
        workKey: key,
        target,
        provenance,
        snapshot: jsonSnapshot(item.snapshot),
        ...(blockedReason
          ? {
              state: "blocked" as const,
              error: blockedReason,
              receipt: { reason: "mailbox_authorization_unavailable" },
            }
          : {}),
      })
      .onConflictDoNothing()
      .returning({ id: aiEvaluation.id });
  if ((await insert(workKey, db)).length) return 1;
  if (blockedReason) return 0;
  // The replacement and its link commit together (connection sweeps pass a plain pool).
  return withTransactionDatabase(db, async (tx) => {
    const [base] = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.workKey, workKey));
    const chain = await workKeyTip(tx, workKey, base);
    if (!chain.reopenable || !chain.tip) return 0;
    const [replacement] = await insert(
      `${workKey}${REOPEN_SEPARATOR}${chain.reopens + 1}`,
      tx,
    );
    if (!replacement) return 0;
    await getDb(tx)
      .update(aiEvaluation)
      .set({
        receipt: {
          ...z
            .record(z.string(), z.unknown())
            .catch({})
            .parse(chain.tip.receipt),
          retryEvaluationId: replacement.id,
        },
        updatedAt: new Date(),
      })
      .where(eq(aiEvaluation.id, chain.tip.id));
    return 1;
  });
}

/**
 * Adds evaluation rows to an existing Run. A target whose work key (record,
 * field and input fingerprint) was already evaluated or is in flight under
 * any Run is not inserted again, while a reopenable settled one gets a
 * replacement row in this Run; the count is what is new or reopened.
 */
export async function insertEvaluationTargets(
  db: Database,
  runId: string,
  targets: readonly EvaluationTargetInput[],
) {
  let inserted = 0;
  for (const item of targets) inserted += await insertTarget(db, runId, item);
  return inserted;
}

type ScheduleEvaluationResult =
  | { kind: "scheduled"; runId: RunId }
  | { kind: "unchanged" }
  | { kind: "deferred"; reason: "scheduling_busy" | "capacity" };

/** Work and its owner commit together. A deferred discovery keeps its cursor. */
export async function scheduleEvaluationRun(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  input: Parameters<typeof ensureRun>[2] & {
    input: z.infer<typeof aiRefreshRunInput>;
  },
  targets: EvaluationTargetInput[],
): Promise<ScheduleEvaluationResult> {
  if (actor.runId)
    throw new Error(
      "Run-scoped actors cannot schedule independent AI refresh owners",
    );
  if (!(await hasAdmissibleTarget(db, targets))) return { kind: "unchanged" };
  return withTransactionDatabase(db, async (tx) => {
    if (!(await tryLockAiRefreshScheduling(tx)))
      return { kind: "deferred", reason: "scheduling_busy" };
    // Do not create empty Runs for terminal, cancelled or already queued work.
    if (!(await hasAdmissibleTarget(tx, targets))) return { kind: "unchanged" };
    const lockRun = async (id: string) =>
      (
        await getDb(tx)
          .select({
            status: run.status,
            failureCode: run.failureCode,
            revision: refreshRunRevision,
          })
          .from(run)
          .where(eq(run.id, runEntityId.parse(id)))
          .for("no key update")
      )[0];
    const [shared] =
      input.status !== "completed" &&
      targets.every((item) => item.target.kind !== "email")
        ? await getDb(tx)
            .select({ id: run.id })
            .from(run)
            .where(
              and(
                eq(run.purpose, "ai_refresh"),
                eq(run.status, "running"),
                eq(run.actorUserId, actor.userId),
                isNull(run.parentRunId),
                sql`coalesce((${run.input}->>${aiRefreshRunInput.keyof().enum.discovery})::boolean, false) = false`,
                sql`${run.input}->>${aiRefreshRunInput.keyof().enum.mailboxId} IS NULL`,
                sql`${refreshRunRevision} = ${input.input.activation.revision}`,
                notDeleted(run),
              ),
            )
            .orderBy(asc(run.createdAt), asc(run.id))
            .limit(1)
            .for("no key update")
        : [];
    if (
      !shared &&
      input.status !== "completed" &&
      !(await hasAiRefreshRunCapacity(tx))
    )
      return { kind: "deferred", reason: "capacity" };
    let runId = shared?.id ?? (await ensureRun(tx, actor, input));
    // Work and its owner become visible together, before recovery can launch a Workflow.
    let owner = await lockRun(runId);
    // A settled Run never relaunches automatically, so new or reopened work continues in a successor.
    if (input.status !== "completed" && input.clientKey)
      for (
        let generation = 1;
        (owner?.status === "completed" ||
          owner?.status === "failed" ||
          owner?.status === "dispatch_failed" ||
          (owner !== undefined &&
            owner.revision !== input.input.activation.revision)) &&
        (await hasAdmissibleTarget(tx, targets));
        generation++
      ) {
        runId = await ensureRun(tx, actor, {
          ...input,
          clientKey: `${input.clientKey}:successor:${generation}`,
        });
        owner = await lockRun(runId);
      }
    let inserted = 0;
    for (const item of targets) inserted += await insertTarget(tx, runId, item);
    if (!inserted)
      await getDb(tx)
        .update(run)
        .set({ status: "completed", endedAt: new Date() })
        .where(
          and(
            eq(run.id, runId),
            eq(run.status, "running"),
            sql`NOT EXISTS (SELECT 1 FROM "AiEvaluation" WHERE "runId" = ${run.id})`,
          ),
        );
    return inserted && input.status !== "completed"
      ? { kind: "scheduled", runId }
      : { kind: "unchanged" };
  });
}

export async function liveProductIdsAfter(
  db: Database,
  after: string | null,
  limit: number,
) {
  return getDb(db)
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        notDeleted(product),
        after ? gt(product.id, parseEntityId("product", after)) : undefined,
      ),
    )
    .orderBy(product.id)
    .limit(limit);
}

// Applications identify logical targets even when inactive or rejected after
// a member correction. Rejected proposals without a receipt stay resolved.
const eligibleSuggestions = () =>
  or(
    eq(suggestion.status, "applied"),
    isNotNull(suggestion.acceptanceReceipt),
    and(
      eq(suggestion.active, true),
      or(
        eq(suggestion.status, "pending"),
        and(
          eq(suggestion.status, "superseded"),
          sql`${suggestion.supersessionReceipt}->>'reason' IN (${suggestionSupersessionReceipt.shape.reason.enum.input_changed}, ${suggestionSupersessionReceipt.shape.reason.enum.no_proposal})`,
        ),
      ),
    ),
  );

/** The newest refreshable field suggestion per (entity, record, field), after the cursor. */
export async function pendingFieldRefreshes(
  db: Database,
  after: FieldRefreshCursor | null,
  limit: number,
) {
  return getDb(db)
    .selectDistinctOn([
      suggestion.entity,
      suggestion.recordId,
      suggestion.field,
    ])
    .from(suggestion)
    .where(
      and(
        eligibleSuggestions(),
        eq(suggestion.family, "field"),
        after
          ? sql`(${suggestion.entity}, ${suggestion.recordId}, ${suggestion.field}) > (${after.entity}, ${after.recordId}::uuid, ${after.field})`
          : undefined,
      ),
    )
    .orderBy(
      asc(suggestion.entity),
      asc(suggestion.recordId),
      asc(suggestion.field),
      desc(suggestion.createdAt),
    )
    .limit(limit);
}

export async function fieldRefreshHistory(
  db: Database,
  key: FieldRefreshCursor,
) {
  return getDb(db)
    .select()
    .from(suggestion)
    .where(
      and(
        eq(suggestion.family, "field"),
        eq(suggestion.entity, key.entity),
        eq(suggestion.recordId, key.recordId),
        eq(suggestion.field, key.field),
        eligibleSuggestions(),
      ),
    )
    .orderBy(desc(suggestion.createdAt));
}

/** Uncertain, unresolved Email without a member classification, with its owner. */
export async function uncertainEmailRefreshCandidates(
  db: Database,
  after: string | null,
  limit: number,
) {
  return getDb(db)
    .select({ item: email, ownerUserId: ledgerParty.userId })
    .from(email)
    .innerJoin(
      ledgerParty,
      and(eq(email.ledgerPartyId, ledgerParty.id), notDeleted(ledgerParty)),
    )
    .where(
      and(
        after ? gt(email.id, after) : undefined,
        notDeleted(email),
        eq(email.classification, "uncertain"),
        notInArray(email.status, [
          "completed",
          "deleted",
          "excluded",
          "researching",
        ]),
        isNull(emailMemberClassificationSql()),
      ),
    )
    .orderBy(asc(email.id))
    .limit(limit);
}

/** Classification observations for these Emails, newest first. */
export async function emailClassificationObservations(
  db: Database,
  emailIds: readonly (typeof email.$inferSelect)["id"][],
) {
  if (!emailIds.length) return [];
  return getDb(db)
    .select()
    .from(emailClassificationObservation)
    .where(inArray(emailClassificationObservation.emailId, [...emailIds]))
    .orderBy(desc(emailClassificationObservation.createdAt));
}

export async function assessmentStatesById(
  db: Database,
  ids: readonly AssessmentStateRow["id"][],
) {
  return getDb(db)
    .select()
    .from(suggestion)
    .where(inArray(suggestion.id, [...ids]));
}

/** Settles a failed refresh attempt only while that attempt still owns the evaluation. */
export async function recordAiRefreshAttemptFailure(
  db: Database,
  id: string,
  attemptToken: string,
  set: {
    state: (typeof aiEvaluation.$inferSelect)["state"];
    attempts: number;
    error: string;
    nextAttemptAt: Date;
  },
) {
  await getDb(db)
    .update(aiEvaluation)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(aiEvaluation.id, id),
        eq(aiEvaluation.attemptToken, attemptToken),
        inArray(aiEvaluation.state, ["running", "result_ready"]),
      ),
    );
}

export async function aiRefreshRelaunchCandidates(db: Database) {
  const current = await readAiRefreshActivation(db);
  return getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "ai_refresh"),
        notDeleted(run),
        or(
          inArray(run.status, ["failed", "dispatch_failed"]),
          and(
            eq(run.status, "running"),
            sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = 0`,
          ),
        ),
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
        sql`coalesce((${run.progress}->>'automaticRecoveryFailures')::int, 0) < ${MAX_AUTOMATIC_WORKFLOW_FAILURES}`,
        or(
          and(
            sql`${run.input}->>${aiRefreshRunInput.keyof().enum.discovery} = 'true'`,
            current?.discoveryRunId
              ? eq(run.id, runEntityId.parse(current.discoveryRunId))
              : sql`false`,
          ),
          sql`EXISTS (SELECT 1 FROM "AiEvaluation" AS eligible WHERE eligible."runId" = ${run.id} AND eligible.state IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.running}, ${aiEvaluationState.enum.result_ready}, ${aiEvaluationState.enum.retry_wait}))`,
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${run.status} = ${runStatus.enum.running} THEN 0 ELSE 1 END`,
      asc(run.updatedAt),
      asc(run.id),
    )
    .limit(10);
}

export async function hasRunnableAiEvaluation(db: Database, runId: string) {
  const [runnable] = await getDb(db)
    .select({ id: aiEvaluation.id })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.runId, runEntityId.parse(runId)),
        inArray(aiEvaluation.state, [
          "queued",
          "running",
          "result_ready",
          "retry_wait",
        ]),
      ),
    )
    .limit(1);
  return Boolean(runnable);
}
