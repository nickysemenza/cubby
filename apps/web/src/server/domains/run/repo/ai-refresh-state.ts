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

import { markAiEvaluationWork } from "~/server/ai/repo/ai-evaluation";
import { evaluationSlotKey } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  product,
  email,
  emailClassificationObservation,
  ledgerParty,
  run,
  assessmentState as suggestion,
} from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";

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

async function slotAdmissions(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  if (!targets.length) return [];
  const unique = [
    ...new Map(
      targets.map((item) => [
        evaluationSlotKey({
          feature: targetFeature(item.target),
          target: item.target,
        }),
        item,
      ]),
    ).entries(),
  ];
  const history = await getDb(db)
    .select({ item: aiEvaluation, failureCode: run.failureCode })
    .from(aiEvaluation)
    .innerJoin(run, eq(run.id, aiEvaluation.runId))
    .where(
      inArray(
        aiEvaluation.slotKey,
        unique.map(([key]) => key),
      ),
    )
    .orderBy(desc(aiEvaluation.createdAt), desc(aiEvaluation.id));
  return unique.map(([slotKey, input]) => {
    const rows = history
      .filter((row) => row.item.slotKey === slotKey)
      .map((row) => ({
        ...row,
        sameInput:
          JSON.stringify(
            aiProvenance.omit({ model: true }).parse(row.item.provenance),
          ) ===
          JSON.stringify(
            aiProvenance.omit({ model: true }).parse(input.provenance),
          ),
      }));
    const open = rows.find(({ item }) => item.state === "queued");
    const common = { input, slotKey, history: rows.map((row) => row.item) };
    if (open)
      return {
        ...common,
        kind:
          !open.sameInput &&
          !input.blockedReason &&
          open.failureCode !== "user_cancelled"
            ? ("update" as const)
            : ("unchanged" as const),
        row: open.item,
      };
    const same = rows.filter((row) => row.sameInput);
    const declined = (row: (typeof rows)[number]) =>
      row.item.state === "blocked" ||
      row.item.state === "obsolete" ||
      (row.item.state === "cancelled" &&
        row.failureCode === SUPERSEDED_RUN_FAILURE);
    const unchanged =
      same[0]?.failureCode === "user_cancelled" ||
      same.some(({ item }) => item.state === "result_ready") ||
      same.filter(declined).length >= MAX_REOPENS ||
      (rows[0]?.sameInput && (input.blockedReason || !declined(rows[0])));
    return {
      ...common,
      kind: unchanged ? ("unchanged" as const) : ("insert" as const),
      row: undefined,
    };
  });
}

/** Whether any logical slot admits current input, using one history read. */
export async function hasAdmissibleTarget(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  return (await slotAdmissions(db, targets)).some(
    (entry) => entry.kind !== "unchanged",
  );
}

/** Admit/update a finite slot set with one history read and set-based writes. */
export async function insertEvaluationTargets(
  db: Database,
  runId: string,
  targets: readonly EvaluationTargetInput[],
  options: { updatesOnly?: boolean } = {},
) {
  if (!targets.length) return 0;
  const keys = [
    ...new Set(
      targets.map((item) =>
        evaluationSlotKey({
          feature: targetFeature(item.target),
          target: item.target,
        }),
      ),
    ),
  ].sort();
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest(ARRAY[${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[]) key ORDER BY key`,
    );
    const admissions = (await slotAdmissions(tx, targets)).filter(
      (entry) =>
        entry.kind !== "unchanged" &&
        (!options.updatesOnly || entry.kind === "update"),
    );
    const prepared = await Promise.all(
      admissions.map(async (entry) => {
        const base = await targetWorkKey(entry.input);
        const held = new Set(
          entry.history
            .filter(
              (row) =>
                row.id !==
                (entry.kind === "update" ? entry.row?.id : undefined),
            )
            .map((row) => row.workKey),
        );
        let workKey = base;
        for (let attempt = 1; held.has(workKey); attempt++)
          workKey = `${base}:attempt:${attempt}`;
        return { ...entry, workKey };
      }),
    );
    const updates = prepared.flatMap((entry) =>
      entry.kind === "update" && entry.row
        ? [{ ...entry, row: entry.row }]
        : [],
    );
    let changed = 0;
    if (updates.length) {
      const values = sql.join(
        updates.map(
          (entry) =>
            sql`(${entry.row.id}::uuid, ${JSON.stringify(entry.input.target)}::jsonb, ${JSON.stringify(entry.input.provenance)}::jsonb, ${JSON.stringify(jsonSnapshot(entry.input.snapshot))}::jsonb, ${entry.workKey}::text)`,
        ),
        sql`, `,
      );
      const written = await getDb(tx)
        .update(aiEvaluation)
        .set({
          target: sql`page.target`,
          provenance: sql`page.provenance`,
          snapshot: sql`page.snapshot`,
          workKey: sql`page.work_key`,
          result: null,
          receipt: null,
          error: null,
          updatedAt: new Date(),
        })
        .from(
          sql`(VALUES ${values}) page(id, target, provenance, snapshot, work_key)`,
        )
        .where(
          and(
            sql`${aiEvaluation.id}=page.id`,
            eq(aiEvaluation.state, "queued"),
          ),
        )
        .returning({ id: aiEvaluation.id });
      // Re-input supersedes an attempt on the previous input.
      await markAiEvaluationWork(
        tx,
        written.map((entry) => entry.id),
      );
      if (written.length)
        await getDb(tx)
          .insert(aiEvaluationRequest)
          .values(
            written.map((entry) => ({
              runId: runEntityId.parse(runId),
              evaluationId: entry.id,
            })),
          )
          .onConflictDoNothing();
      changed += written.length;
    }
    const fresh = prepared.filter((entry) => entry.kind === "insert");
    if (fresh.length) {
      const inserted = await getDb(tx)
        .insert(aiEvaluation)
        .values(
          fresh.map((entry) => ({
            runId: runEntityId.parse(runId),
            feature: targetFeature(entry.input.target),
            workKey: entry.workKey,
            target: entry.input.target,
            provenance: entry.input.provenance,
            snapshot: jsonSnapshot(entry.input.snapshot),
            ...(entry.input.blockedReason
              ? {
                  state: "blocked" as const,
                  error: entry.input.blockedReason,
                  receipt: { reason: "mailbox_authorization_unavailable" },
                }
              : {}),
          })),
        )
        .onConflictDoNothing()
        .returning();
      if (inserted.length)
        await getDb(tx)
          .insert(aiEvaluationRequest)
          .values(
            inserted.map((entry) => ({
              runId: runEntityId.parse(runId),
              evaluationId: entry.id,
            })),
          )
          .onConflictDoNothing();
      await markAiEvaluationWork(
        tx,
        inserted.map((entry) => entry.id),
      );
      changed += inserted.length;
    }
    return changed;
  });
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
    const updates = (await slotAdmissions(tx, targets)).filter(
      (entry) => entry.kind === "update" && entry.row,
    );
    const updatedOwner = updates[0]?.row?.runId;
    if (updatedOwner)
      await insertEvaluationTargets(tx, updatedOwner, targets, {
        updatesOnly: true,
      });
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
    const inserted = await insertEvaluationTargets(tx, runId, targets);
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
