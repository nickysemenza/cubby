import {
  aiRefreshActivation,
  aiProvenance,
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

import {
  availableEvaluationWorkKey,
  evaluationSlotKey,
} from "~/server/ai/repo/ai-evaluation-requests";
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
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";

import {
  hasAiRefreshRunCapacity,
  tryLockAiRefreshScheduling,
} from "./ai-refresh-admission";
import { recordAiEvaluationAttemptFailure } from "./ai-work-state";
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
      slotKey: evaluationSlotKey({ feature: targetFeature(target), target }),
      provenance: { ...provenance, model: null },
    }),
  );

// Persistently declined input gets a bounded number of automatic attempts.
const MAX_REOPENS = 3;
/** failureCode of a Run whose queued work was cleared as redundant, not refused. */
export const SUPERSEDED_RUN_FAILURE = "superseded";
const refreshRunRevision = sql<number>`coalesce((${run.input}->${aiRefreshRunInput.keyof().enum.activation}->>${aiRefreshActivation.keyof().enum.revision})::int, 0)`;

const targetFeature = (target: AiEvaluationTarget) =>
  target.kind === "connection"
    ? "entity-connections"
    : target.kind === "field"
      ? "field-suggestion"
      : target.kind === "product" || target.kind === "product_pair"
        ? "product-identity"
        : "mailbox-triage";

async function slotAdmission(db: Database, item: EvaluationTargetInput) {
  const slotKey = evaluationSlotKey({
    feature: targetFeature(item.target),
    target: item.target,
  });
  const rows = await getDb(db)
    .select({
      item: aiEvaluation,
      failureCode: run.failureCode,
      sameInput: sql<boolean>`(${aiEvaluation.provenance} - ${aiProvenance.keyof().enum.model}::text) = (${JSON.stringify(item.provenance)}::jsonb - ${aiProvenance.keyof().enum.model}::text)`,
    })
    .from(aiEvaluation)
    .innerJoin(run, eq(run.id, aiEvaluation.runId))
    .where(eq(aiEvaluation.slotKey, slotKey))
    .orderBy(desc(aiEvaluation.createdAt), desc(aiEvaluation.id));
  const open = rows.find(
    ({ item }) => item.state === "queued" || item.state === "retry_wait",
  );
  if (open)
    return !open.sameInput &&
      !item.blockedReason &&
      open.failureCode !== "user_cancelled"
      ? { kind: "update" as const, row: open.item }
      : { kind: "unchanged" as const };
  const same = rows.filter((row) => row.sameInput);
  const declined = (row: (typeof rows)[number]) =>
    row.item.state === "blocked" ||
    row.item.state === "obsolete" ||
    (row.item.state === "cancelled" &&
      row.failureCode === SUPERSEDED_RUN_FAILURE);
  if (
    same[0]?.failureCode === "user_cancelled" ||
    same.some(
      ({ item }) => item.state === "running" || item.state === "result_ready",
    ) ||
    same.filter(declined).length >= MAX_REOPENS ||
    (rows[0]?.sameInput && (item.blockedReason || !declined(rows[0])))
  )
    return { kind: "unchanged" as const };
  return { kind: "insert" as const };
}

/** Whether a slot needs new input or a new attempt, without walking receipts. */
export async function hasAdmissibleTarget(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  for (const item of targets)
    if ((await slotAdmission(db, item)).kind !== "unchanged") return true;
  return false;
}

async function insertTarget(
  db: Database,
  runId: string,
  item: EvaluationTargetInput,
): Promise<number> {
  const { target, provenance, blockedReason } = item;
  const feature = targetFeature(target);
  const slotKey = evaluationSlotKey({ feature, target });
  const baseKey = await targetWorkKey(item);
  return withTransactionDatabase(db, async (tx) => {
    // Serialize admission even when the slot has no row yet. The partial unique
    // index also fences producers outside this path and concurrent member retries.
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${slotKey}, 0))`,
    );
    const admission = await slotAdmission(tx, item);
    if (admission.kind === "unchanged") return 0;
    const workKey = await availableEvaluationWorkKey(tx, {
      baseKey,
      slotKey,
      updatingId: admission.kind === "update" ? admission.row.id : undefined,
    });
    if (admission.kind === "update") {
      // A Job may claim the row after the admission read. Never overwrite an
      // executing snapshot; rediscovery will queue current input beside it.
      const updated = await getDb(tx)
        .update(aiEvaluation)
        .set({
          provenance,
          snapshot: jsonSnapshot(item.snapshot),
          workKey,
          target,
          // Retry-wait rows can retain a prior provider result. New input must
          // never publish that result under its replacement provenance.
          result: null,
          receipt: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiEvaluation.id, admission.row.id),
            inArray(aiEvaluation.state, ["queued", "retry_wait"]),
          ),
        )
        .returning({ id: aiEvaluation.id });
      return updated.length || insertTarget(tx, runId, item);
    }
    const [row] = await getDb(tx)
      .insert(aiEvaluation)
      .values({
        runId: runEntityId.parse(runId),
        feature,
        workKey,
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
    if (!row) return 0;
    if (!blockedReason)
      await enqueueJob(tx, {
        key: `ai-evaluation:${row.id}`,
        kind: "ai.evaluation",
        input: { evaluationId: row.id },
      });
    return 1;
  });
}

/** Admit current input once per slot; queued input updates retain their row and Job. */
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
    // Updating a queued slot keeps its original owner, even when a mailbox
    // roster is full or the caller would otherwise open a new Run.
    let updatedOwner: RunId | undefined;
    for (const item of targets) {
      const admission = await slotAdmission(tx, item);
      if (
        admission.kind === "update" &&
        (await insertTarget(tx, admission.row.runId, item))
      )
        updatedOwner = admission.row.runId;
    }
    if (!(await hasAdmissibleTarget(tx, targets)))
      return updatedOwner
        ? { kind: "scheduled", runId: updatedOwner }
        : { kind: "unchanged" };
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

/** Automatic and requested evaluations share the same slot-safe failure transition. */
export async function recordAiRefreshAttemptFailure(
  db: Database,
  id: string,
  attemptToken: string,
  set: { state: (typeof aiEvaluation.$inferSelect)["state"]; error: string },
) {
  await recordAiEvaluationAttemptFailure(db, { id, attemptToken }, set);
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
