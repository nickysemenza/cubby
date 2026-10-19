import {
  aiEvaluationState,
  aiRefreshRunInput,
  suggestionSupersessionReceipt,
  type AiEvaluationTarget,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
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

/** The row a work key's retries and reopens currently end at, with its reopen count. */
async function workKeyTip(db: Database, workKey: string) {
  const [base] = await getDb(db)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.workKey, workKey));
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
    if (row.workKey.startsWith(`${workKey}${REOPEN_SEPARATOR}`)) reopens++;
  }
  return {
    tip,
    reopens,
    reopenable:
      tip !== undefined &&
      ["blocked", "obsolete"].includes(tip.state) &&
      reopens < MAX_REOPENS,
  };
}

/** Whether any target would insert a new row or reopen a settled one. */
async function hasAdmissibleTarget(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  for (const item of targets) {
    const chain = await workKeyTip(db, await targetWorkKey(item));
    if (!chain.tip || (chain.reopenable && !item.blockedReason)) return true;
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
  const insert = (key: string) =>
    getDb(db)
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
  if ((await insert(workKey)).length) return 1;
  if (blockedReason) return 0;
  const chain = await workKeyTip(db, workKey);
  if (!chain.reopenable || !chain.tip) return 0;
  const [replacement] = await insert(
    `${workKey}${REOPEN_SEPARATOR}${chain.reopens + 1}`,
  );
  if (!replacement) return 0;
  await getDb(db)
    .update(aiEvaluation)
    .set({
      receipt: {
        ...z.record(z.string(), z.unknown()).catch({}).parse(chain.tip.receipt),
        retryEvaluationId: replacement.id,
      },
      updatedAt: new Date(),
    })
    .where(eq(aiEvaluation.id, chain.tip.id));
  return 1;
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

/** Creates (or rejoins) a refresh Run and its evaluation rows in one transaction; null when nothing new needs a Workflow. */
export async function scheduleEvaluationRun(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  input: Parameters<typeof ensureRun>[2],
  targets: EvaluationTargetInput[],
) {
  return withTransactionDatabase(db, async (tx) => {
    const lockRun = async (id: string) =>
      (
        await getDb(tx)
          .select({ status: run.status, failureCode: run.failureCode })
          .from(run)
          .where(eq(run.id, runEntityId.parse(id)))
          .for("no key update")
      )[0];
    let runId = await ensureRun(tx, actor, input);
    // Work and its owner become visible together, before recovery can launch a Workflow.
    let owner = await lockRun(runId);
    // A settled Run never relaunches automatically, so new or reopened work continues in a successor.
    if (input.status !== "completed" && input.clientKey)
      for (
        let generation = 1;
        (owner?.status === "completed" ||
          owner?.failureCode === "user_cancelled") &&
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
    return inserted && input.status !== "completed" ? runId : null;
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

const eligibleSuggestions = () =>
  or(
    eq(suggestion.status, "pending"),
    and(
      eq(suggestion.status, "superseded"),
      sql`${suggestion.supersessionReceipt}->>'reason' IN (${suggestionSupersessionReceipt.shape.reason.enum.input_changed}, ${suggestionSupersessionReceipt.shape.reason.enum.no_proposal})`,
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
        eq(suggestion.active, true),
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
          eq(run.status, "failed"),
          and(
            eq(run.status, "running"),
            sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = 0`,
          ),
        ),
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
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
    .orderBy(asc(run.updatedAt), asc(run.id))
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
