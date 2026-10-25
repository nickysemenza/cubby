import {
  aiRefreshActivation,
  aiRefreshRunInput,
  suggestionSupersessionReceipt,
  suggestionAcceptanceReceipt,
  type AiEvaluationTarget,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import {
  parseEntityId,
  runEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
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

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
  runBeforeCommitDatabase,
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
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { assertCurrentJob } from "~/server/generic/jobs/repo/execution";
import { cancelJob, enqueueJob } from "~/server/generic/jobs/repo/jobs";

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
/** failureCode of a Run whose queued work was cleared as redundant, not refused. */
export const SUPERSEDED_RUN_FAILURE = "superseded";
const REOPEN_SEPARATOR = ":reopen:";
const retryReceipt = z.object({ retryEvaluationId: z.uuid() });
/**
 * Cancelled because the record changed before it ran, not by a member: the
 * record can change back, so this work key may reopen.
 */
const supersededReceipt = z.object({ supersededBy: z.uuid() });
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
    tip && ["blocked", "obsolete", "cancelled"].includes(tip.state)
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
      reopens < MAX_REOPENS &&
      // A member's cancel of the owning Run vetoes every reopen, also of work
      // superseded before that cancel.
      owner?.failureCode !== "user_cancelled" &&
      // A Run stopped as superseded (backlog cleared, not a member's decision)
      // leaves its cancelled work for paced discovery to re-admit.
      (tip.state === "cancelled"
        ? owner?.failureCode === SUPERSEDED_RUN_FAILURE ||
          supersededReceipt.safeParse(tip.receipt).success
        : ["blocked", "obsolete"].includes(tip.state)),
  };
}

/**
 * A changed record's new fingerprint replaces its older queued evaluation:
 * that one can only end obsolete, and keeping it doubles the backlog.
 */
async function supersedeQueuedConnectionWork(
  db: Database,
  target: EvaluationTargetInput["target"],
  keepId: string,
) {
  if (target.kind !== "connection") return;
  const stale = await getDb(db)
    .update(aiEvaluation)
    .set({
      state: "cancelled",
      error: "Superseded by a newer evaluation of the changed record",
      receipt: { supersededBy: keepId },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiEvaluation.feature, "entity-connections"),
        inArray(aiEvaluation.state, ["queued", "retry_wait"]),
        sql`${aiEvaluation.id} <> ${keepId}::uuid`,
        sql`${aiEvaluation.target}->>'entity' = ${target.entity}`,
        sql`${aiEvaluation.target}->>'recordId' = ${target.recordId}`,
      ),
    )
    .returning({ id: aiEvaluation.id });
  if (!stale.length) return;
  const executions = await getDb(db).execute<{ id: string }>(
    sql`SELECT id FROM "Job" WHERE key IN (${sql.join(
      stale.map((row) => sql`${`ai-evaluation:${row.id}`}`),
      sql`, `,
    )})`,
  );
  for (const execution of executions.rows) await cancelJob(db, execution.id);
}

/** Whether any target would insert a new row or reopen a settled one. */
export async function hasAdmissibleTarget(
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
    withTransactionDatabase(client, async (tx) => {
      const rows = await getDb(tx)
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
      if (!blockedReason)
        for (const row of rows) {
          await enqueueJob(tx, {
            key: `ai-evaluation:${row.id}`,
            kind: "ai.evaluation",
            input: { evaluationId: row.id },
          });
          if (target.kind === "connection")
            await supersedeQueuedConnectionWork(tx, target, row.id);
        }
      return rows;
    });
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

/** Settle an evaluation with no replacement without rewriting historical Feedback. */
export async function settleAppliedFieldRefresh(
  db: Database,
  id: string,
  fingerprint: string,
  provenance: AiProvenance,
) {
  await transitionAssessmentStates(
    db,
    and(eq(suggestion.id, id), eq(suggestion.family, "field")),
    (row) => {
      const receipt = suggestionAcceptanceReceipt
        .nullable()
        .parse(row.acceptanceReceipt ?? null);
      if (!receipt) return null;
      return {
        acceptanceReceipt: {
          ...receipt,
          evaluatedInput: { fingerprint, provenance },
        },
      };
    },
    { kind: "field_refresh_evaluated" },
  );
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
    error: string;
  },
) {
  const execution = currentJobExecution();
  if (
    !execution ||
    execution.claim.kind !== "ai.evaluation" ||
    execution.claim.key !== `ai-evaluation:${id}` ||
    execution.claim.leaseToken !== attemptToken
  )
    throw new Error(
      "AI evaluation failure requires its current universal Job claim",
    );
  await withTransactionDatabase(db, async (tx) => {
    await assertCurrentJob(tx);
    await getDb(tx)
      .update(aiEvaluation)
      .set({ state: set.state, error: set.error, updatedAt: new Date() })
      .where(
        and(
          eq(aiEvaluation.id, id),
          inArray(aiEvaluation.state, ["running", "result_ready"]),
        ),
      );
  });
}

/**
 * Fence a publication on the source fingerprint its evaluation was claimed
 * with, read once at commit inside the serializable transaction. Each unit's
 * own basis is rechecked under its locks; this read is the source-wide fence.
 */
export async function checkConnectionSourceBeforeCommit(
  db: Database,
  fingerprint: () => Promise<string>,
  expected: string,
) {
  await runBeforeCommitDatabase(
    db,
    async () => {
      if ((await fingerprint()) !== expected)
        throw new Error("Connection source changed before commit");
    },
    "fence",
  );
}
